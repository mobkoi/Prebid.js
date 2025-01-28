/**
 * This module adds mobkoiId support to the User ID module
 * The {@link module:modules/userId} module is required.
 * @module modules/mobkoiIdSystem
 * @requires module:modules/userId
 */

import { submodule } from '../src/hook.js';
import { MODULE_TYPE_UID } from '../src/activities/modules.js';
import { getCoreStorageManager } from '../src/storageManager.js';
import { createInvisibleIframe, logError, logInfo, deepAccess, insertElement, insertUserSyncIframe, triggerPixel, safeJSONParse, getUnixTimestampFromNow } from '../src/utils.js';
import { ajax } from '../src/ajax.js';

const GVL_ID = 898;
const MODULE_NAME = 'mobkoiId';
const PROD_AD_SERVER_BASE_URL = 'https://adserver.maximus.mobkoi.com';
/**
 * !IMPORTANT: This value must match the value in mobkoiAnalyticsAdapter.js
 * The name of the parameter that the publisher can use to specify the ad server endpoint.
 */
const PARAM_NAME_AD_SERVER_BASE_URL = 'adServerBaseUrl';

export const storage = getCoreStorageManager(MODULE_NAME);

export const mobkoiIdSubmodule = {
  name: MODULE_NAME,

  decode(value) {
    return value ? { [MODULE_NAME]: value } : undefined;
  },

  gvlid: GVL_ID,

  getId(userSyncOptions, gdprConsent) {
    if (storage.cookiesAreEnabled()) {
      logInfo('Cookies are enabled', storage);
    } else {
      logError('Cookies are not enabled. Module will not work.');
      return;
    }

    const cookieName = deepAccess(userSyncOptions, 'storage.name');
    const existingId = storage.getCookie('mobkoiId');

    if (existingId) {
      logInfo(`Found ID from local cookie: "${existingId}"`);
      // return { id: existingId };
    } else {
      logInfo(`No ID found in local cookie with name: "${cookieName}"`);
    }

    return {
      callback: () => {
        requestEquativUserId(
          userSyncOptions,
          gdprConsent,
          (userId) => {
            if (userId) {
              logInfo(`Successfully fetched Equativ SAS ID: ${userId}`);
              storage.setCookie(
                'mobkoiId',
                userId,
                Infinity
              );
            }
          }
        );
      }
    };
  },
};

submodule('userId', mobkoiIdSubmodule);

// function requestEquativUserId(syncUserOptions, gdprConsent, onCompleteCallback) {
//   logInfo('Requesting Equativ SAS ID');

//   const smartAdServerUrl = buildSmartAdServerUrl(syncUserOptions, gdprConsent);

//   triggerPixel(smartAdServerUrl, function () {
//     logInfo('Equativ Pixel loaded');

//     const mobkoiCookie = this.document.cookie
//       .split('; ')
//       .find(row => row.startsWith('mobkoi_uid='));

//     if (mobkoiCookie) {
//       const userId = mobkoiCookie.split('=')[1];
//       onCompleteCallback(userId);
//     }
//   });
// }

function requestEquativUserId(syncUserOptions, gdprConsent, onCompleteCallback) {
  const smartAdServerUrl = buildSmartAdServerUrl(syncUserOptions, gdprConsent);

  const url = 'https://adserver.local.mobkoi.com/pixeliframe?callbackUrl=' + encodeURIComponent(smartAdServerUrl);

  console.log('iframe url', url);

  window.addEventListener('message', function(event) {
    console.log('window', window);
    switch(event.data.type) {
      case 'DEBUG':
        // Log debug messages with their type (INFO/ERROR)
        console.log(`[${event.data.debugType}] ${event.data.message}`);
        break;
      
      case 'PIXEL_SYNC_COMPLETE':
        // Handle successful sync
        console.log('Sync completed:', event.data.data);
        break;
      
      case 'PIXEL_SYNC_ERROR':
        // Handle error
        console.error('Sync failed:', event.data.error);
        break;
    }
  });

  insertUserSyncIframe(url, () => {
    // console.log('Iframe loaded');
    // const iframes = document.getElementsByTagName('iframe');
    // for (let i = 0; i < iframes.length; i++) {
    //   if (iframes[i].src === url) {
    //     const iframe = iframes[i];
    //     console.log('Found iframe', iframe);
    //     iframes[i].onload = function() {
    //       console.log('this', this);
    //       const iframeDocument = iframes[i].contentDocument || iframes[i].contentWindow.document;
    //       console.log('Iframe document:', iframeDocument);
    //       console.log('Iframe cookies:', iframeDocument.cookie);
    //       const mobkoiCookie = iframeDocument.cookie
    //         .split('; ')
    //         .find(row => row.startsWith('mobkoi_uid='));
    //       console.log('Mobkoi cookie:', mobkoiCookie);
    //     };
    //     break;
    //   }
    // }
  });
}

function buildSmartAdServerUrl(syncUserOptions, gdprConsent) {
  logInfo('Generating Equativ SAS ID request URL');
  const adServerBaseUrl = new URL(deepAccess(syncUserOptions, `params.${PARAM_NAME_AD_SERVER_BASE_URL}`) || PROD_AD_SERVER_BASE_URL);
  const cookieName = deepAccess(syncUserOptions, 'storage.name');
  const gdprConsentString = gdprConsent && gdprConsent.gdprApplies ? gdprConsent.consentString : null;

  if (!cookieName) {
    logError('Equativ SAS ID requires a storage name to be defined');
    return;
  }

  const setUidCallback = encodeURIComponent(`${adServerBaseUrl}setuid?`) +
    encodeURIComponent('uid=') + '[sas_uid]' +
    encodeURIComponent(`&cookieName=${cookieName}`);

  const smartServerUrl = `https://sync.smartadserver.com/getuid?url=` +
    setUidCallback +
    // `&gdpr_consent=${gdprConsentString}` +
    `&gdpr=0` +
    `&nwid=5290`;

  return smartServerUrl;
}
