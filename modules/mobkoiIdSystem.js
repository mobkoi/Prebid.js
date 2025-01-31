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
export const PROD_AD_SERVER_BASE_URL = 'https://adserver.maximus.mobkoi.com';
export const COOKIE_KEY_EQUATIV_SAS_ID = '__mobkoi_sas_id';
export const EQUATIV_BASE_URL = 'https://sync.smartadserver.com';
export const EQUATIV_NETWORK_ID = '5290';
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
    logInfo('Getting Equativ SAS ID');

    if (!storage.cookiesAreEnabled()) {
      logError('Cookies are not enabled. Module will not work.');
      return {
        id: null
      };
    }

    const existingId = storage.getCookie(COOKIE_KEY_EQUATIV_SAS_ID);

    if (existingId) {
      logInfo(`Found "${COOKIE_KEY_EQUATIV_SAS_ID}" from local cookie: "${existingId}"`);
      return { id: existingId };
    }

    logInfo(`Cannot found "${COOKIE_KEY_EQUATIV_SAS_ID}" in local cookie with name.`);
    return {
      callback: () => {
        return new Promise((resolve, _reject) => {
          utils.requestEquativSasId(
            userSyncOptions,
            gdprConsent,
            (sasId) => {
              if (!sasId) {
                logError('Equativ SAS ID is empty');
                resolve({ id: null });
                return;
              }

              logInfo(`Fetched Equativ SAS ID: "${sasId}"`);
              storage.setCookie(COOKIE_KEY_EQUATIV_SAS_ID, sasId);
              logInfo(`Stored Equativ SAS ID in local cookie with name: "${COOKIE_KEY_EQUATIV_SAS_ID}"`);
              resolve({ id: sasId });
            }
          );
        });
      }
    };
  },
};

submodule('userId', mobkoiIdSubmodule);

export const utils = {
  requestEquativSasId(syncUserOptions, gdprConsent, onCompleteCallback) {
    logInfo('Start requesting Equativ SAS ID');
    const adServerBaseUrl = new URL(
      deepAccess(
        syncUserOptions,
        `params.${PARAM_NAME_AD_SERVER_BASE_URL}`) || PROD_AD_SERVER_BASE_URL
    );

    const equativPixelUrl = utils.buildEquativPixelUrl(syncUserOptions, gdprConsent);
    logInfo('Equativ SAS ID request URL:', equativPixelUrl);

    const url = adServerBaseUrl + '/pixeliframe?' +
      'pixelUrl=' + encodeURIComponent(equativPixelUrl) +
      '&cookieName=sas_uid';

    /**
     * Listen for messages from the iframe
     */
    window.addEventListener('message', function(event) {
      switch (event.data.type) {
        case 'MOBKOI_PIXEL_SYNC_COMPLETE':
          const sasUid = event.data.syncData;
          logInfo('Parent window Sync completed. SAS ID:', sasUid);
          onCompleteCallback(sasUid);
          break;
        case 'MOBKOI_PIXEL_SYNC_ERROR':
          logError('Parent window Sync failed:', event.data.error);
          break;
      }
    });

    insertUserSyncIframe(url, () => {
      logInfo('insertUserSyncIframe loaded');
    });

    // Return the URL for testing purposes
    return url;
  },

  /**
   * Build a pixel URL that will be placed in an iframe to fetch the Equativ SAS ID
   */
  buildEquativPixelUrl(syncUserOptions, gdprConsent) {
    logInfo('Generating Equativ SAS ID request URL');
    const adServerBaseUrl = new URL(
      deepAccess(
        syncUserOptions,
        `params.${PARAM_NAME_AD_SERVER_BASE_URL}`) || PROD_AD_SERVER_BASE_URL
    );

    const gdprConsentString = gdprConsent && gdprConsent.gdprApplies ? gdprConsent.consentString : '';
    const smartServerUrl = EQUATIV_BASE_URL + '/getuid?' +
      `url=` + encodeURIComponent(`${adServerBaseUrl}getPixel?value=`) + '[sas_uid]' +
      `&gdpr_consent=${gdprConsentString}` +
      `&nwid=${EQUATIV_NETWORK_ID}`;

    return smartServerUrl;
  }
};
