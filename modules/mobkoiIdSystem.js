/**
 * This module adds mobkoiId support to the User ID module
 * The {@link module:modules/userId} module is required.
 * @module modules/mobkoiIdSystem
 * @requires module:modules/userId
 */

import { submodule } from '../src/hook.js';
import { getCoreStorageManager } from '../src/storageManager.js';
import { logError, logInfo, deepAccess, insertUserSyncIframe } from '../src/utils.js';

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

function requestEquativUserId(syncUserOptions, gdprConsent, onCompleteCallback) {
  logInfo('Requesting Equativ SAS ID');

  const equativPixelUrl = buildEquativPixelUrl(syncUserOptions, gdprConsent);
  logInfo('Equativ SAS ID request URL:', equativPixelUrl);

  const url = 'https://adserver.local.mobkoi.com/pixeliframe?' +
    'pixelUrl=' + encodeURIComponent(equativPixelUrl) +
    '&cookieName=sas_uid';

  /**
   * Listen for messages from the iframe
   */
  window.addEventListener('message', function(event) {
    switch (event.data.type) {
      case 'MOBKOI_PIXEL_SYNC_COMPLETE':
        logInfo('Parent window Sync completed:', event.data.data);
        break;
      case 'MOBKOI_PIXEL_SYNC_ERROR':
        logError('Parent window Sync failed:', event.data.error);
        break;
    }
  });

  insertUserSyncIframe(url, () => {
    logInfo('insertUserSyncIframe loaded');
  });
}

/**
 * Build a pixel URL that will be placed in an iframe to fetch the Equativ SAS ID
 */
function buildEquativPixelUrl(syncUserOptions, gdprConsent) {
  logInfo('Generating Equativ SAS ID request URL');
  const adServerBaseUrl = new URL(deepAccess(syncUserOptions, `params.${PARAM_NAME_AD_SERVER_BASE_URL}`) || PROD_AD_SERVER_BASE_URL);

  const gdprConsentString = gdprConsent && gdprConsent.gdprApplies ? gdprConsent.consentString : null;
  const smartServerUrl = 'https://sync.smartadserver.com/getuid?' +
    `url=` + encodeURIComponent(`${adServerBaseUrl}setuid?uid=`) + '[sas_uid]' +
    // `&gdpr_consent=${gdprConsentString}` +
    `&gdpr=0` +
    `&nwid=5290`;

  return smartServerUrl;
}
