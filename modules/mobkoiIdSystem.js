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

  insertUserSyncIframe(smartAdServerUrl, () => {
    console.log('this', this);
    const mobkoiIdCookie = this.cookie.match('(^|;)\\s*mobkoiId\\s*=\\s*([^;]*)\\s*(;|$)');
    console.log('Cookie value:', mobkoiIdCookie ? decodeURIComponent(mobkoiIdCookie[2]) : null);
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
    `&gdpr_consent=${gdprConsentString}` +
    `&nwid=5290`;

  return smartServerUrl;
}
