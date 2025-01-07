import mobkoiAnalyticsAdapter, { LocalContext, DEBUG_EVENT_LEVELS, utils, SUB_PAYLOAD_UNIQUE_FIELDS_LOOKUP, SUB_PAYLOAD_TYPES } from 'modules/mobkoiAnalyticsAdapter.js';
import adapterManager from '../../../src/adapterManager.js';
import * as events from 'src/events.js';
import { EVENTS } from 'src/constants.js';
import sinon from 'sinon';

const defaultTimeout = 10000;

const performStandardAuction = (auctionEvents) => {
  auctionEvents.forEach(auctionEvent => {
    events.emit(auctionEvent.event, auctionEvent.data);
  });
}

const getMockEvents = () => {
  const ortb2 = {
    site: {
      publisher: {
        id: 'mobkoiPublisherId',
        ext: { adServerBaseUrl: 'http://test-endpoint' }
      }
    }
  }
  const requestId = '28df0355619026'
  const transactionId = '3d43c05d-0970-4e62-b5b2-ef9afec2093e'
  const auctionId = '688e03d7-2695-434c-b819-f8c43707b150';
  const sizes = [800, 300];
  const bidId = '3973172c31de61';
  const timestamp = Date.now();
  const bid = { bidder: 'mobkoi', adUnitCode: 'banner-ad', bidId, ortb2 }
  const auctionOrBidError = {timestamp, error: 'error', bidderRequest: { bidderRequestId: requestId }}

  return {
    AUCTION_TIMEOUT: auctionOrBidError,
    AUCTION_INIT: {
      timestamp,
      auctionId,
      auctionStatus: 'inProgress',
      adUnits: [{
        adUnitId: '53e7b1dd-9242-453e-b9f0-98b7fed7b971',
        code: 'banner-ad',
        mediaTypes: { banner: { sizes: [sizes] } },
        transactionId,
      }],
      bidderRequests: [{
        bidderRequestId: requestId,
        bids: [bid],
        ortb2
      }]
    },
    BID_RESPONSE: {
      auctionId,
      timestamp,
      requestId: bidId,
      bidId,
      ortbId: requestId,
      cpm: 1.5,
      currency: 'USD',
      ortbBidResponse: {
        id: requestId,
        impid: bidId,
        price: 1.5
      }
    },
    NO_BID: auctionOrBidError,
    BIDDER_DONE: {
      timestamp,
      auctionId,
      bidderRequestId: requestId,
      bids: [bid],
      ortb2
    },
    BID_WON: {
      timestamp,
      auctionId,
      requestId,
      bidId,
      ortbBidResponse: {
        id: requestId,
        impid: bidId
      }
    },
    AUCTION_END: {
      timestamp,
      auctionId,
      auctionStatus: 'completed'
    },
    AD_RENDER_SUCCEEDED: {
      bid: {
        timestamp,
        requestId: bidId,
        bidId,
        ortbId: requestId,
        ad: '<div>test ad</div>'
      },
      doc: { visibilityState: 'visible' }
    },
    AD_RENDER_FAILED: {
      bid: {
        timestamp,
        requestId: bidId,
        bidId,
        ortbId: requestId,
        ad: '<div>test ad</div>'
      },
      reason: 'error',
      message: 'error'
    },
    BIDDER_ERROR: auctionOrBidError,
    BID_REJECTED: {
      timestamp,
      error: 'error',
      bidderRequestId: requestId
    }
  }
}

describe('mobkoiAnalyticsAdapter', function () {
  it('should registers with the adapter manager', function () {
    // should refer to the BIDDER_CODE in the mobkoiAnalyticsAdapter
    const adapter = adapterManager.getAnalyticsAdapter('mobkoi');
    expect(adapter).to.exist;
    // should refer to the GVL_ID in the mobkoiAnalyticsAdapter
    expect(adapter.gvlid).to.equal(898);
    expect(adapter.adapter).to.equal(mobkoiAnalyticsAdapter);
  });

  describe('Tracks events', function () {
    let adapter;
    let sandbox;
    let pushEventSpy;
    let flushEventsSpy;
    let triggerBeaconSpy;

    beforeEach(function () {
      adapter = mobkoiAnalyticsAdapter;

      sandbox = sinon.createSandbox({
        useFakeTimers: {
          now: new Date(2025, 0, 8, 0, 1, 33, 425),
        },
      });

      // Enable analytics with fresh context
      adapter.enableAnalytics({
        options: {
          endpoint: 'http://test-endpoint',
          pid: 'test-pid',
          timeout: defaultTimeout,
        }
      });

      // Create spies after enabling analytics to ensure localContext exists
      pushEventSpy = sandbox.spy(adapter.localContext, 'pushEventToAllBidContexts');
      flushEventsSpy = sandbox.spy(adapter.localContext, 'flushAllDebugEvents');
      triggerBeaconSpy = sandbox.spy(adapter.localContext, 'triggerAllLossBidLossBeacon')
    });

    afterEach(function () {
      sandbox.restore();
      adapter.disableAnalytics();
    });

    it('should track complete auction workflow in correct sequence and trigger a loss beacon', function () {
      const { AUCTION_INIT, BID_RESPONSE, AUCTION_END, AD_RENDER_SUCCEEDED, BIDDER_DONE } = getMockEvents();

      const eventSequence = [
        { event: EVENTS.AUCTION_INIT, data: AUCTION_INIT },
        { event: EVENTS.BID_RESPONSE, data: BID_RESPONSE },
        { event: EVENTS.AD_RENDER_SUCCEEDED, data: AD_RENDER_SUCCEEDED },
        { event: EVENTS.AUCTION_END, data: AUCTION_END },
        { event: EVENTS.BIDDER_DONE, data: BIDDER_DONE }
      ];

      performStandardAuction(eventSequence);
      expect(pushEventSpy.callCount).to.equal(3); // AUCTION_INIT, AUCTION_END, BIDDER_DONE
      expect(flushEventsSpy.callCount).to.equal(1);
      expect(triggerBeaconSpy.callCount).to.equal(1); // BIDDER_DONE
    });

    it('should track errors events', function () {
      const { AUCTION_TIMEOUT, NO_BID, BID_REJECTED, BIDDER_ERROR, AD_RENDER_FAILED } = getMockEvents();

      const eventSequence = [
        { event: EVENTS.AUCTION_TIMEOUT, data: AUCTION_TIMEOUT },
        { event: EVENTS.NO_BID, data: NO_BID },
        { event: EVENTS.BID_REJECTED, data: BID_REJECTED },
        { event: EVENTS.BIDDER_ERROR, data: BIDDER_ERROR },
        { event: EVENTS.AD_RENDER_FAILED, data: AD_RENDER_FAILED }
      ];

      performStandardAuction(eventSequence);

      expect(pushEventSpy.callCount).to.equal(3); // AUCTION_TIMEOUT, NO_BID, BIDDER_ERROR
    });

    it('should push unexpected error events to the localContext', function () {
      const { AUCTION_INIT } = getMockEvents();
      delete AUCTION_INIT.auctionStatus;

      const eventSequence = [
        { event: EVENTS.AUCTION_INIT, data: AUCTION_INIT }
      ];

      performStandardAuction(eventSequence);

      expect(pushEventSpy.calledOnce).to.be.true;
      const errorEventCall = pushEventSpy.getCall(0);

      expect(errorEventCall.args[0]).to.deep.include({
        eventType: EVENTS.AUCTION_INIT,
        level: DEBUG_EVENT_LEVELS.error,
        note: 'Error occurred when processing this event.'
      });

      const errorPayload = errorEventCall.args[0].subPayloads[`errorInEvent_${EVENTS.AUCTION_INIT}`];
      expect(errorPayload).to.exist;
      expect(errorPayload.error).to.include('Unable to determine track args type');
    });
  })

  describe('utils', function () {
    const adServerBaseUrl = 'http://adServerBaseUrl';

    const getBidderRequest = () => ({
      bidderCode: 'mobkoi',
      auctionId: '90acf3a8-7710-48f9-8009-f7a985d0e605',
      bidderRequestId: '2bcbed44fb310c',
      bids: [{
        bidder: 'mobkoi',
        adUnitCode: 'banner-ad',
        transactionId: 'e4895800-1a69-472c-9e6d-277a1ae1a119',
        adUnitId: '6d636e93-32ac-4dc6-8a07-fa4167660265',
        bidId: '3973172c31de61',
        bidderRequestId: '2bcbed44fb310c',
        auctionId: '90acf3a8-7710-48f9-8009-f7a985d0e605',
        ortb2: {
          site: {
            publisher: {
              id: 'mobkoiPublisherId',
              ext: {
                adServerBaseUrl
              }
            },
          }
        }
      }],
      ortb2: {
        site: {
          publisher: {
            id: 'mobkoiPublisherId',
            ext: {
              adServerBaseUrl
            }
          },
        },
      }
    })

    const adm = '<div>test ad</div>';
    const lurl = 'test.com/loss';
    const nurl = 'test.com/win';

    const getBidderResponse = () => ({
      body: {
        id: '2bcbed44fb310c',
        cur: 'USD',
        seatbid: [
          {
            seat: 'mobkoi_debug',
            bid: [
              {
                id: '2bcbed44fb310c',
                impid: '3973172c31de61',
                cid: 'campaign_1',
                crid: 'creative_1',
                price: 1,
                cur: [
                  'USD'
                ],
                adomain: [
                  'advertiser.com'
                ],
                adm,
                w: 300,
                h: 250,
                mtype: 1,
                lurl,
                nurl
              }
            ]
          }
        ],
      }
    })

    let bidderRequest;

    beforeEach(function () {
      bidderRequest = getBidderRequest();
    });

    describe('isMobkoiBid', function () {
      it('should return true when the bid is from mobkoi', function () {
        expect(utils.isMobkoiBid(bidderRequest)).to.be.true;
      });
      it('should return false when the bid is not from mobkoi', function () {
        bidderRequest.bidderCode = 'anything';
        expect(utils.isMobkoiBid(bidderRequest)).to.be.false;
      });
    });

    describe('getOrtbId', function () {
      it('should return the ortbId from the prebid request object (i.e bidderRequestId)', function () {
        expect(utils.getOrtbId(bidderRequest)).to.equal(bidderRequest.bidderRequestId);
      });

      it('should return the ortbId from the prebid response object (i.e seatBidId)', function () {
        const customBidRequest = { ...bidderRequest, seatBidId: bidderRequest.bidderRequestId };
        delete customBidRequest.bidderRequestId;
        expect(utils.getOrtbId(customBidRequest)).to.equal(bidderRequest.bidderRequestId);
      });

      it('should return the ortbId from the interpreted prebid response object (i.e ortbId)', function () {
        const customBidRequest = { ...bidderRequest, ortbId: bidderRequest.bidderRequestId };
        delete customBidRequest.bidderRequestId;
        expect(utils.getOrtbId(customBidRequest)).to.equal(bidderRequest.bidderRequestId);
      });

      it('should return the ortbId from the ORTB request object (i.e has imp)', function () {
        const customBidRequest = { ...bidderRequest, imp: {}, id: bidderRequest.bidderRequestId };
        delete customBidRequest.bidderRequestId;
        expect(utils.getOrtbId(customBidRequest)).to.equal(bidderRequest.bidderRequestId);
      });

      it('should throw error when ortbId is missing', function () {
        delete bidderRequest.bidderRequestId;
        expect(() => {
          utils.getOrtbId(bidderRequest);
        }).to.throw();
      });
    })

    describe('getImpId', function () {
      let bidResponse;
      beforeEach(function () {
        const bidderResponse = getBidderResponse();
        bidResponse = bidderResponse.body.seatbid[0].bid[0];
      });

      it('should return the impId from the impid field', function () {
        expect(utils.getImpId(bidResponse)).to.equal(bidResponse.impid);
      });

      it('should return the impId from the requestId field', function () {
        const customBidResponse = { ...bidResponse, requestId: bidResponse.impid };
        delete customBidResponse.impid;
        expect(utils.getImpId(customBidResponse)).to.equal(bidResponse.impid);
      });

      it('should return the impId from the bidId field', function () {
        const customBidResponse = { ...bidResponse, bidId: bidResponse.impid };
        delete customBidResponse.impid;
        expect(utils.getImpId(customBidResponse)).to.equal(bidResponse.impid);
      });

      it('should return null if impId is missing', function () {
        expect(utils.getImpId({})).to.be.null;
      });
    })

    describe('getPublisherId', function () {
      it('should return the publisherId from the given object', function () {
        expect(utils.getPublisherId(bidderRequest)).to.equal(bidderRequest.ortb2.site.publisher.id);
      });

      it('should throw error when publisherId is missing', function () {
        delete bidderRequest.ortb2.site.publisher.id;
        expect(() => {
          utils.getPublisherId(bidderRequest);
        }).to.throw();
      });
    })

    describe('getAdServerEndpointBaseUrl', function () {
      it('should return the adServerBaseUrl from the given object', function () {
        expect(utils.getAdServerEndpointBaseUrl(bidderRequest))
          .to.equal(adServerBaseUrl);
      });

      it('should throw error when adServerBaseUrl is missing', function () {
        delete bidderRequest.ortb2.site.publisher.ext.adServerBaseUrl;

        expect(() => {
          utils.getAdServerEndpointBaseUrl(bidderRequest);
        }).to.throw();
      });
    })

    describe('determineObjType', function () {
      [null, undefined, 123, 'string', true].forEach(value => {
        it(`should throw an error when input is ${value}`, function() {
          expect(() => {
            utils.determineObjType(value);
          }).to.throw();
        });
      });

      it('should throw an error if the object type could not be determined', function () {
        expect(() => {
          utils.determineObjType({dumbAttribute: 'bid'})
        }).to.throw();
      });

      Object.values(SUB_PAYLOAD_TYPES).forEach(type => {
        it(`should return the ${type} type`, function () {
          const eventArgs = {}
          const uniqueFields = SUB_PAYLOAD_UNIQUE_FIELDS_LOOKUP[type]
          uniqueFields.forEach(field => {
            eventArgs[field] = 'random-value'
          })
          expect(utils.determineObjType(eventArgs)).to.equal(type);
        })
      })
    })

    describe('mergePayloadAndCustomFields', function () {
      it('should throw an error when the target is not an object', function () {
        expect(() => {
          utils.mergePayloadAndCustomFields(123, {})
        }).to.throw();
      })

      it('should throw an error when the new values are not an object', function () {
        expect(() => {
          utils.mergePayloadAndCustomFields({}, 123)
        }).to.throw();
      })

      it('should throw an error if custom fields are provided and one of them is not a string', () => {
        const customFields = {impid: 'bid-123', bidId: 123}
        expect(() => {
          utils.mergePayloadAndCustomFields({}, customFields)
        }).to.throw();
      })
    })

    describe('validateSubPayloads', function () {
      it('should throw an error if the sub payloads required fields are not the correct type', function () {
        expect(() => {
          utils.validateSubPayloads({
            [SUB_PAYLOAD_TYPES.ORTB_BID]: {
              impid: 123,
              publisherId: 456
            }
          })
        }).to.throw();
      });

      it('should not throw when sub payloads have valid required fields', function () {
        expect(() => {
          utils.validateSubPayloads({
            [SUB_PAYLOAD_TYPES.ORTB_BID]: {
              impid: '123',
              publisherId: 'publisher-123'
            }
          })
        }).to.not.throw();
      });
    });
  })
});
