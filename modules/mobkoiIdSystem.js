/**
 * This module adds mobkoiId support to the User ID module
 * The {@link module:modules/userId} module is required.
 * @module modules/mobkoiIdSystem
 * @requires module:modules/userId
 */

import { submodule } from '../src/hook.js';
import { MODULE_TYPE_UID } from '../src/activities/modules.js';
import { getStorageManager } from '../src/storageManager.js';
import { logError, logInfo, deepAccess } from '../src/utils.js';
import { ajax } from '../src/ajax.js';
import { config } from '../src/config.js';

const GVL_ID = 898;
const MODULE_NAME = 'mobkoiId';
const STORAGE_KEY_PREFIX = 'mobkoi';
const PROD_AD_SERVER_BASE_URL = 'https://adserver.maximus.mobkoi.com';
/**
 * !IMPORTANT: This value must match the value in mobkoiAnalyticsAdapter.js
 * The name of the parameter that the publisher can use to specify the ad server endpoint.
 */
const PARAM_NAME_AD_SERVER_BASE_URL = 'adServerBaseUrl';

const StorageKeys = {
  mobkoiUid: `${STORAGE_KEY_PREFIX}_uid`,
  equativSasId: `${STORAGE_KEY_PREFIX}_sas_uid`
}

export const storage = getStorageManager({
  moduleType: MODULE_TYPE_UID,
  moduleName: MODULE_NAME
});

export const mobkoiIdSubmodule = {
  name: MODULE_NAME,

  decode(value) {
    return value ? { [MODULE_NAME]: value } : undefined;
  },

  gvlid: GVL_ID,

  getId(userSyncOptions, gdprConsent) {
    const uidStorageName = userSyncOptions.storage.name;
    const existingId = getStoredUid(uidStorageName);

    if (existingId) {
      logInfo(`Found ID from local storage ${uidStorageName}=${existingId}`);
      return { id: existingId };
    }

    return {
      callback: () => {
        requestMobkoiUserId(
          userSyncOptions,
          (userId) => {
            if (userId) {
              storeValue(StorageKeys.mobkoiUid, userId);
            }
          }
        );

        requestEquativUserId(
          userSyncOptions,
          gdprConsent,
          (userId) => {
            if (userId) {
              storeValue(StorageKeys.equativSasId, userId);
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
  const adServerBaseUrl = deepAccess(syncUserOptions, `params.${PARAM_NAME_AD_SERVER_BASE_URL}`) || PROD_AD_SERVER_BASE_URL;

  const setUidCallback = new URL('/echo', adServerBaseUrl);
  setUidCallback.searchParams.set('value', '[sas_uid]');

  const workingGdpr = 'CQLOJoAQLOJoABIACDPLBYFkAP_gAEPgAB5YKvtX_G__bWlr8X73aftkeY1P99h77sQxBhfJE-4FzLvW_JwXx2ExNA36tqIKmRIAu3TBIQNlGJDURVCgaogVryDMaEyUoTNKJ6BkiFMRI2dYCFxvm4tjeQCY5vr991dx2B-t7dr83dzyy4hHn3a5_2S0WJCdA5-tDfv9bROb-9IOd_x8v4v4_F_pE2_eT1l_tWvp7D9-cts_9XW99_ffff9Pn_-uB_-_X_vf_H34KvgEmGhUQBlgSEhBoGEECAFQVhARQIAgAASBogIATBgU7AwAXWEiAEAKAAYIAQAAgyABAAABAAhEAEABQIAAIBAoAAwAIBgIACBgABABYCAQAAgOgYpgQQCBYAJGZFQpgQhAJBAS2VCCQBAgrhCEWeARAIiYKAAAAAApAAEBYLA4kkBKhIIAuINoAACABAIIAChBJyYAAgDNlqDwYNoytMAwfMEiGmAZAEQRkJBoAAAA.YAAAAAAAAAAA';

  const url = new URL('https://sync.smartadserver.com/getuid');
  url.searchParams.set('url', setUidCallback);
  url.searchParams.set('nwid', '5290');
  // url.searchParams.set('gdpr_consent', gdprConsent ? gdprConsent.consentString : '');
  url.searchParams.set('gdpr_consent', workingGdpr);

  ajax(
    url.toString(),
    {
      success: (data) => {
        logInfo({data});
        try {
          const userId = JSON.parse(data).value;
          onCompleteCallback(userId);
        } catch (e) {
          logError('Error parsing Equativ ID response:', e);
          onCompleteCallback(null);
        }
      },
      error: (status, error) => {
        logError('Error fetching Equativ ID:', status, error);
        onCompleteCallback(null);
      }
    },
    null,
    {
      method: 'GET',
      withCredentials: true
    });
}

function requestMobkoiUserId(syncUserOptions, onCompleteCallback) {
  logInfo('Requesting Mobkoi UID');
  const adServerBaseUrl = deepAccess(syncUserOptions, `params.${PARAM_NAME_AD_SERVER_BASE_URL}`) || PROD_AD_SERVER_BASE_URL;

  const setUidCallback = new URL('/echo', adServerBaseUrl);
  setUidCallback.searchParams.set('value', '[mobkoi_uid]');

  const getUidUrl = new URL('/getuid', adServerBaseUrl);
  getUidUrl.searchParams.set('callbackUrl', setUidCallback.toString());

  ajax(
    getUidUrl.toString(),
    {
      success: (data) => {
        try {
          const userId = JSON.parse(data).value;
          logInfo(`Successfully fetched Mobkoi UID: ${userId}`);
          onCompleteCallback(userId);
        } catch (e) {
          logError('Error parsing Mobkoi ID response:', e);
          onCompleteCallback(null);
        }
      },
      error: (status, error) => {
        logError('Error fetching Mobkoi UID:', status, error);
        onCompleteCallback(null);
      }
    },
    null,
    {
      method: 'GET',
      withCredentials: true
    });
}

function storeValue(storageKey, value) {
  if (!isStorageKeyValid(storageKey)) {
    logError(`Invalid storage key: "${storageKey}". Valid keys are: ${Object.values(StorageKeys).join(', ')}`);
    return;
  }

  storage.setDataInLocalStorage(storageKey, value);
}

function getStoredUid(storageKey) {
  if (!isStorageKeyValid(storageKey)) {
    logError(`Invalid storage key: "${storageKey}". Valid keys are: ${Object.values(StorageKeys).join(', ')}`);
    return null;
  }

  return window[storageKey] ||
    storage.localStorageIsEnabled() ? storage.getDataFromLocalStorage(storageKey) : null;
}

function isStorageKeyValid(storageKey) {
  return Object.values(StorageKeys).includes(storageKey);
}
