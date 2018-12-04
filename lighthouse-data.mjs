/**
 * Copyright 2018 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import childProcess from 'child_process';
const exec = util.promisify(childProcess.exec);
import fs from 'fs';
import util from 'util';

import * as utils from './public/utils.mjs';
import async from 'async';
import fetch from 'node-fetch';
import gcs from '@google-cloud/storage';
const CloudStorage = gcs.Storage;
import isSameDay from 'date-fns/is_same_day';
import AbortController from 'abort-controller';
import Firestore from '@google-cloud/firestore';
import LighthouseAPI from './lighthouse-api.mjs';
// import Memcache from './memcache.mjs';
import ReportGenerator from 'lighthouse/lighthouse-core/report/report-generator.js';

const SERVICE_ACCOUNT_FILE = './serviceAccount.json';
const STORAGE_BUCKET = 'webdotdevsite.appspot.com';
const serviceAccountJSON = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE));

const USE_CACHE = true;
const MAX_REPORTS = 10;
// Start query from last known invalid url. Last entry in file is the url we
// left off at.
const INVALID_URLS_FILENAME = './invalidurls.txt';
/**
 * Uploads the LH report to Firebase cloud storage.
 * @param {!Object} lhr Full lhr object
 * @param {string} name Report name.
 * @return {!Promise<undefined>}
 * @export
 */
async function uploadReport(lhr, name) {
  const bucket = storage.bucket(STORAGE_BUCKET);
  const filename = `lhrs/${name}.json`;
  return await bucket.file(filename).save(JSON.stringify(lhr), {
    gzip: true,
    resumable: false,
  });
}

/**
 * Downloads the full LH report from Firebase cloud storage.
 * @param {string} url Target url for the report.
 * @return {?Promise<!Object>} Resolves with LHR json.
 * @export
 */
export async function getFullReport(url) {
  const bucket = storage.bucket(STORAGE_BUCKET);

  const filenames = [
    `lhrs/${utils.slugify(url)}.json`,
    `lhrs/${encodeURI(utils.slugify(url))}.json`, // attemp to file url encoded version.
  ];

  for (const filename of filenames) {
    const file = bucket.file(filename);
    const fileExists = (await file.exists())[0];
    if (fileExists) {
      const data = await file.download();
      const lhr = JSON.parse(data);
      return lhr;
    }
  }

  return null;
}

/**
 * Saves Lighthouse report to Firestore.
 * @param {string} url URL to save run under.
 * @param {!Object} json
 * @param {boolean} replace If true, replaces the last saved report with this
 *     new result. False, saves a new report.
 * @return {!Promise<!Object>}
 * @export
 */
export async function finalizeReport(url, json, replace) {
  const lhr = json.lhr;

  delete lhr.i18n; // remove cruft we don't to store.

  // Trim down the LH results to only include category/scores.
  const categories = JSON.parse(JSON.stringify(lhr.categories)); // clone it.
  const lhrSlim = Object.values(categories).map(cat => {
    delete cat.auditRefs;
    return cat;
  });

  const today = new Date();
  const data = {
    lhrSlim,
    auditedOn: today,
  };

  if (json.crux && Object.keys(json.crux).length) {
    data.crux = json.crux;
  }

  const collectionRef = db.collection(utils.slugify(url));
  const querySnapshot = await collectionRef
      .orderBy('auditedOn', 'desc').limit(1).get();

  const lastDoc = querySnapshot.docs[0];
  if (lastDoc) {
    const lastDocAuditedOn = lastDoc.data().auditedOn;
    const ts = new Firestore.Timestamp(
        lastDocAuditedOn._seconds, lastDocAuditedOn._nanoseconds);

    // If user hits the "Run Audit" more than once on the same day, (force)
    // replace their latest report for the day rather than creating a new entry.
    if (isSameDay(ts.toDate(), today)) {
      replace = true;
    }
  }

  // GCP always stores the latest full report.
  await uploadReport(lhr, utils.slugify(url));

  if (replace && lastDoc) {
    await lastDoc.ref.update(data); // Replace last entry with updated vals.
  } else {
    await collectionRef.add(data); // Add new report.
  }

  // TODO: when we re-enable the cron, it should not update the last viewed.
  await updateLastViewed(url); // Update url's last touch timestamp.

  // // Clear relevant caches.
  // await Promise.all([
  //   memcache.delete(`getReports_${utils.slugify(url)}`),
  // ]);

  data.lhr = lhr; // add back in full lhr to return val.

  return data;
}

/**
 * Returns urls with lastViewed date older than cutoff date.
 * @param {Date} cutoffDate Date before which urls are considered stale.
 * @return {!Array<string>}
 * @export
 */
export async function getUrlsLastViewedBefore(cutoffDate) {
  const metaCollection = db.collection('meta');
  const staleUrls = [];
  await metaCollection
      .where('lastViewed', '<', cutoffDate)
      .get()
      .then(snapshot => snapshot.forEach(doc => {
        staleUrls.push(doc.id);
      }));
  return staleUrls;
}

/**
 * Audits a site using Lighthouse CI infra.
 * @param {string} url Url to audit.
 * @param {boolean=} replace If true, replaces the last saved report with this
 *     new result. False, saves a new report. Defaults to false.
 * @return {!Object} Report object saved to Firestore.
 * @export
 */
export async function runLighthouseCI(url, replace=false) {
  const CI_URL = 'https://builder-dot-lighthouse-ci.appspot.com/ci';
  const CI_API_KEY = 'webdev';

  console.info('Using Lighthouse CI', url);

  let json = {};

  try {
    const resp = await fetch(CI_URL, {
      method: 'POST',
      body: JSON.stringify({url, format: 'json'}),
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': CI_API_KEY,
      }
    });

    if (!resp.ok) {
      console.log(resp);
      throw new Error(`(${resp.status}) ${resp.statusText}`);
    }

    const lhr = await resp.json();

    // https://github.com/GoogleChrome/lighthouse/issues/6336
    if (lhr.runtimeError && lhr.runtimeError.code !== 'NO_ERROR') {
      throw new Error(`${lhr.runtimeError.code} ${lhr.runtimeError.message}`);
    }

    json = await finalizeReport(url, {lhr}, replace);
  } catch (err) {
    console.log(err);
    json.errors = `${err}`;
  }

  return json;
}

/**
 * Audits a site using the Lighthouse API.
 * @param {string} url Url to audit.
 * @param {boolean=} replace If true, replaces the last saved report with this
 *     new result. False, saves a new report. Defaults to false.
 * @return {!Object} API response.
 * @export
 */
export async function runLighthouseAPI(url, replace=false) {
  const api = new LighthouseAPI(serviceAccountJSON.PSI_API_KEY);

  let json = {};
  try {
    json = await api.audit(url);

    // https://github.com/GoogleChrome/lighthouse/issues/6336
    if (json.lhr.runtimeError && json.lhr.runtimeError.code !== 'NO_ERROR') {
      throw new Error(
          `${json.lhr.runtimeError.code} ${json.lhr.runtimeError.message}`);
    }

    json = await finalizeReport(url, json, replace);
  } catch (err) {
    console.error(err);
    json.errors = `${err}`;
  }

  return json;
}

/**
 * @param (!Function) url
 */
export function getAllSavedUrls(onResults, {
    totalNumBatches = Number.POSITIVE_INFINITY, batchSize = 1000,
    startAfter = null}={}) {
  const urls = [];

  const queryNextPage = (startAfter = null, batchNum = 1) => {
    if (batchNum > totalNumBatches) {
      onResults({complete: true, urls: []});
      return;
    }

    let query = db.collection('meta').orderBy('__name__').limit(batchSize);

    if (startAfter) {
      query = query.startAfter(startAfter);
    }

    query.get().then(snapshot => {
      if (snapshot.empty) {
        onResults({complete: true, urls: []});
        return;
      }

      const newUrls = snapshot.docs
        .filter(doc => doc.id.startsWith('http'))
        .map(doc => ({
          url: utils.deslugify(doc.id),
          lastViewed: new Date(doc.data().lastViewed.seconds * 1000),
        }));

      onResults({urls: newUrls, complete: false});

      const lastDocInQueryResult = snapshot.docs.slice(-1)[0];
      queryNextPage(lastDocInQueryResult, batchNum + 1);
    });
  };

  queryNextPage(startAfter);
}


/**
 * Updates the last viewed metadata for a URL.
 * @param {string} url
 * @return {!Promise}
 */
async function updateLastViewed(url) {
  return db.doc(`meta/${utils.slugify(url)}`).update({lastViewed: new Date()});
}

/**
 * Updates the last verified metadata for a URL.
 * @param {string} url
 * @return {!Promise}
 */
async function updateLastVerified(url) {
  return db.doc(`meta/${utils.slugify(url)}`).update({lastVerified: new Date()});
}

/**
 * @param {string} docId Document id in Firestore.
 * @return {!Promise<?Number>}
 */
export async function getCount(docId) {
  const ref = db.collection('counters').doc(docId);
  const doc = await ref.get();
  return !doc.exists ? null : Number(doc.data().count);
}

/**
 * @param {string} docId Document id in Firestore.
 * @param {Number=} val If present, sets counter to val.
 * @return {!Promise}
 */
export async function incrementCounter(docId, val = null) {
  const ref = db.collection('counters').doc(docId);
  const doc = await ref.get();
  if (!doc.exists) {
    console.warn(
      `Could not increment counter /counters/${doc}. It does not exist.`);
    return;
  }
  const count = val !== null ? val : Number(doc.data().count) + 1;
  return ref.update({count});
}

/**
 * Increments the interest count for an url.
 * @param {string} url
 * @return {!Promise<number>} Promise that resolves the new interest count
 *     for the url.
 */
export async function incrementInterestCount(url) {
  const docRef = db.doc(`meta/${utils.slugify(url)}`);
  const meta = await docRef.get();
  const {interestCount = 0} = meta.data();
  await docRef.udpate({interestCount: ++interestCount});
  return interestCount;
}

/**
 * Decrements the interest count for an url.
 * @param {string} url
 * @return {!Promise<number>} Promise that resolves the new interest count
 *     for the url.
 */
export async function decrementInterestCount(url) {
  const docRef = db.doc(`meta/${utils.slugify(url)}`);
  const meta = await docRef.get();
  const {interestCount = 0} = meta.data();
  await docRef.update({interestCount: --interestCount});
  return interestCount;
}

/**
 * Returns all saved scores, per category.
 * @param {string} url
 * @param {number=} maxResults Max number of reports to return. Defaults to
 *     MAX_REPORTS.
 * @return {!Promise<!Object>}
 */
async function getAllScores(url, maxResults=MAX_REPORTS) {
  const querySnapshot = await db.collection(`${utils.slugify(url)}`)
      .orderBy('auditedOn', 'desc').limit(maxResults).get();

  const runs = querySnapshot.docs;
  runs.reverse(); // Order reports from oldest -> most recent.

  const scores = {};
  runs.map(doc => {
    doc.get('lhrSlim').forEach(cat => {
      if (!scores[cat.id]) {
        scores[cat.id] = [];
      }
      scores[cat.id].push(cat.score * 100);
    });
  });

  return scores;
}

/**
 *  Updates the last viewed metadata for a URL.
 * @param {string} url
 * @param {number=} maxResults Max number of reports to return. Defaults to
 *     MAX_REPORTS.
 * @return {!Promise}
 * @export
 */
export async function getMedianScores(url, maxResults=MAX_REPORTS) {
  const scores = await getAllScores(url, maxResults);

  // Calculate medians
  const medians = {};
  Object.entries(scores).map(([cat, scores]) => {
    medians[cat] = utils.median(scores);
  });

  return medians;
}

/**
 *  Gets the median scores for all categories, across all saved urls.
 * @param {{maxResults: number=, useCache: boolean=}} Config object.
 * @return {!Promise<!Object>}
 * @export
 */
export async function getMedianScoresOfAllUrls(
    {maxResults, useCache}={maxResults: MAX_REPORTS, useCache: USE_CACHE}) {
  // if (useCache) {
  //   const val = await memcache.get('getMedianScoresOfAllUrls');
  //   if (val) {
  //     return val;
  //   }
  // }

  console.warn('No cached medians.');

  return {};
}

// /**
//  * Updates median scores for all categories, across all urls.
//  * @param {{maxResults: number=, useCache: boolean=}} Config object.
//  * @return {!Promise<!Object>}
//  * @export
//  */
// export async function updateMedianScoresOfAllUrls(
//     {maxResults, useCache}={maxResults: 1, useCache: USE_CACHE}) {
//   const combinedScores = {};
//   const urls = await getAllSavedUrls();

//   console.info(`Calculating median category scores of ${urls.length} urls`);

//   const urlScores = await Promise.all(
//     urls.map(url => getAllScores(url, maxResults)));
//   for (const score of urlScores) {
//     Object.entries(score).map(([cat, scores]) => {
//       if (!combinedScores[cat]) {
//         combinedScores[cat] = [];
//       }
//       combinedScores[cat].push(...scores);
//     });
//   }

//   // Calculate medians
//   const medians = {};
//   Object.entries(combinedScores).map(([cat, scores]) => {
//     medians[cat] = utils.median(scores);
//   });

//   // if (useCache) {
//   //   const success = await memcache.set('getMedianScoresOfAllUrls', medians);
//   //   console.log(`Median scores saved to memcache: ${success}`);
//   // }

//   return medians;
// }

/**
 * Get saved reports for a given URL.
 * @param {string} url URL to fetch reports for.
 * @param {{maxResults: number=, useCache: boolean=}}
 *     Config object.
 * @param {boolean=} useCache If false, bypasses cache. Defaults to true.
 * @return {!Array<Object>} The reports.
 * @export
 */
export async function getReports(url,
    {maxResults, useCache}={maxResults: MAX_REPORTS, useCache: USE_CACHE}) {
  // const cacheKey = `getReports_${utils.slugify(url)}`;
  // if (useCache) {
  //   const val = await memcache.get(cacheKey);
  //   if (val) {
  //     await updateLastViewed(url); // "touch" last viewed timestamp for URL.
  //     return val;
  //   }
  // }

  const querySnapshot = await db.collection(utils.slugify(url))
      .orderBy('auditedOn', 'desc').limit(maxResults).get();

  let runs = [];

  if (querySnapshot.empty) {
    return runs;
  } else {
    querySnapshot.forEach(doc => runs.push(doc.data()));
    runs.reverse(); // Order reports from oldest -> most recent.
    await updateLastViewed(url); // "touch" url's last viewed date.
  }

  runs = runs.map(r => {
    const ts = new Firestore.Timestamp(
        r.auditedOn._seconds, r.auditedOn._nanoseconds);
    r.auditedOn = ts.toDate();
    return r;
  });

  // Attach full lighthouse report to last entry.
  runs[runs.length - 1].lhr = await getFullReport(url);

  // if (useCache) {
  //   await memcache.set(cacheKey, runs);
  // }

  return runs;
}

/**
 * Deletes a subcollection in Firestore by batch.
 * @param {!Object} query Firestore subcollection query.
 * @param {!Function} resolve Function to call when all batches are deleted.
 * @param {!Function} reject Function to call in case of error.
 */
function deleteBatch_(query, resolve, reject) {
  query.get().then((snapshot) => {
      if (snapshot.size === 0) {
        return 0;
      }
      const batch = db.batch();
      snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });
      return batch.commit().then(() => snapshot.size);
    }).then((numDeleted) => {
      if (numDeleted === 0) {
        resolve();
        return;
      }
      // Recurse on the next process tick, to avoid
      // exploding the stack.
      // @see https://firebase.google.com/docs/firestore/manage-data/delete-data
      process.nextTick(() => {
        deleteBatch_(query, resolve, reject);
      });
    })
    .catch(reject);
}

/**
 * Deletes all saved reports for a given URL.
 * @param {string} url URL to fetch reports for.
 * @return {!Promise<boolean>}
 * @export
 */
export async function deleteReports(url) {
  const batchSize = 20;
  const collectionRef = db.collection(utils.slugify(url));
  const query = collectionRef.orderBy('__name__').limit(batchSize);

  const deletePromise = new Promise((resolve, reject) => {
    deleteBatch_(query, resolve, reject);
  });

  // Delete reports and memcache data.
  await Promise.all([
    deletePromise,
    // memcache.delete(`getReports_${utils.slugify(url)}`),
  ]);

  return Promise.resolve(true);
}

/**
 * Deletes url metadata.
 * @param {string} url
 * @return {!Promise}
 * @export
 */
export async function deleteMetadata(url) {
  return db.collection('meta').doc(utils.slugify(url)).delete();
}

/**
 * Removes a URL from firestore.
 * @param {string} url
 * @return {!Promise}
 */
export function removeUrl(url) {
  return Promise.all([
    deleteReports(url),
    deleteMetadata(url),
  ]);
}

/**
 *
 * @param {string} method HTTP method
 * @param {string} url
 * @param {number=} timeout. Defaults to 10s.
 * @return {!Promise<boolean>}
 */
async function fetchWithTimeout(method, url, timeout=10 * 1000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const valid = await fetch(url, {
    method,
    redirect: 'follow',
    signal: controller.signal,
    // Handle common redirect scenario: http:// -> https:// -> https://www
    follow: 4,
    size: 0, // Response body size. 0 disables it.
    compress: true,
  }).then(resp => {
    console.log(resp.status, resp.statusText, resp.ok, url);

    // If server doesn't support HEAD request, consider it a valid URL.
    if (resp.status === 405) {
      return true;
    }

    return resp.ok;
  }).catch(err => {
    console.log(`${err.name}: ${err.message} - ${url}`);
    // If request timed out, we don't know if the URL was good. Consider it
    // valid to play it safe.
    if (err.name === 'AbortError') {
      return true;
    }
    return false;
  });

  clearTimeout(timeoutId);

  return valid;
}

/**
 * Finds all invalid urls (e.g. that return 400s, 500s) and removes them from
 * the system.
 * @return {!Promise<{{numRemoved: number, allUrls: !Array<!Object>}}>}
 * @export
 */
export async function removeInvalidUrls() {
  const allUrls = [];
  let numRemoved = 0;

  // First, ensure the url list in the file is sorted because items were added
  // async and are out of order. Want to start at the correct page in firestore.
  const lines = fs.readFileSync(INVALID_URLS_FILENAME, {encoding: 'utf8'})
    .split('\n').filter(String).sort();
  fs.writeFileSync(INVALID_URLS_FILENAME, lines.join('\n') + '\n');

  const {stdout} = await exec(`tail -1 ${INVALID_URLS_FILENAME}`);
  const lastUrl = stdout.trim();
  const startAfter = lastUrl.startsWith('http') ? utils.slugify(lastUrl) : null;

  let resolver;
  const promise = new Promise(resolve => resolver = resolve);

  getAllSavedUrls(async ({urls, complete}) => {
    if (!complete) {
      allUrls.push(...urls);
      console.info(`Fetched ${allUrls.length} urls.`);
      return;
    }

    console.info(`Validating ${allUrls.length} urls`);

    const stream = fs.createWriteStream(INVALID_URLS_FILENAME, {flags: 'a'});

    try {
      const start = Date.now();

      const tasks = allUrls.map(item => {
        return async function() {
          // Use GET requests b/c they're reliable than HEAD requests.
          // Some servers don't respond to HEAD.
          const urlIsOk = await fetchWithTimeout('GET', item.url, 30 * 1000);
          await updateLastVerified(item.url);
          if (!urlIsOk) {
            numRemoved++;
            console.log(item.url);
            stream.write(`${item.url}\n`);
            // await removeUrl(item.url);
          }
          return {ok: urlIsOk, url: item.url};
        };
      });

      const parallelLimit = util.promisify(async.parallelLimit);
      const results = await parallelLimit(async.reflectAll(tasks), 20);

      console.log(`Validated ${results.length} urls. Removed ${numRemoved}.`);
      console.log(`Took ${(Date.now() - start) / 1000} seconds`);
    } catch (err) {
      console.error('Async task error', err);
    }

    stream.end();

    resolver({numRemoved, urls});

  }, {totalNumBatches: 20, batchSize: 1000, startAfter});

  return promise;
}

/**
 * Generates a LH report in different formats.
 * @param {!Object} lhr Lighthouse report object.
 * @param {string} format How to format the report. One 'html', 'json', 'csv'.
 * @return {string} Report.
 * @export
 */
export function generateReport(lhr, format) {
  return ReportGenerator.generateReport(lhr, format);
}

const db = new Firestore({
  projectId: serviceAccountJSON.project_id,
  keyFilename: SERVICE_ACCOUNT_FILE,
  timestampsInSnapshots: true,
});

// const memcache = new Memcache();

const storage = new CloudStorage({
  projectId: serviceAccountJSON.project_id,
  keyFilename: SERVICE_ACCOUNT_FILE,
});


// (async() => {
// const urls = fs.readFileSync(INVALID_URLS_FILENAME, {encoding: 'utf8'}).split('\n').filter(String);
// for (const url of urls) {
//   console.log('removing', url);
//   await removeUrl(url);
// }
// })();

// db.collection('meta').orderBy('__name__')
// .startAfter('http:____www.awwwards.com').limit(10000).get().then(docs => {
//   docs.forEach(async doc => {
//     const data = doc.data();
//     if (!('lastViewed' in data)) {
//       await doc.ref.update({lastViewed: new Date()});
//       console.log('no last viewed', doc.id);
//     }
//   });
// });
