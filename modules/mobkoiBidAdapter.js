import { ortbConverter } from '../libraries/ortbConverter/converter.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER } from '../src/mediaTypes.js';

const BIDDER_CODE = 'mobkoi';
const AD_SERVER_ENDPOINT = 'http://127.0.0.1:8000/bid';

const converter = ortbConverter({
  context: {
    netRevenue: true,
    ttl: 30,
  },
  // imp(buildImp, bidRequest, context) {
  //   const imp = buildImp(bidRequest, context);
  //   if (!imp.bidfloor) {
  //     imp.bidfloor = bidRequest.params.bidfloor || 0;
  //     imp.bidfloorcur = bidRequest.params.currency || DEFAULT_CURRENCY;
  //   }
  //   if (bidRequest.params.battr) {
  //     Object.keys(bidRequest.mediaTypes).forEach(mType => {
  //       imp[mType].battr = bidRequest.params.battr;
  //     })
  //   }
  //   return imp;
  // },
  // request(buildRequest, imps, bidderRequest, context) {
  //   const request = buildRequest(imps, bidderRequest, context);
  //   const bid = context.bidRequests[0];
  //   if (!request.cur) {
  //     request.cur = [bid.params.currency || DEFAULT_CURRENCY];
  //   }
  //   if (bid.params.bcat) {
  //     request.bcat = bid.params.bcat;
  //   }
  //   return request;
  // },
  bidResponse(buildBidResponse, bid, context) {
    // eslint-disable-next-line no-console
    console.log({ context, bid });

    const bidResponse = buildBidResponse(bid, context);
    return bidResponse;
  }
});

export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: [BANNER],

  isBidRequestValid: function (bid) {
    return true;
  },

  buildRequests: function (validBidRequests, bidderRequest) {
    const ortb = converter.toORTB({ validBidRequests, bidderRequest });
    return {
      method: 'POST',
      url: AD_SERVER_ENDPOINT,
      data: {
        ortb,
        bidderRequest
      },
      options: {
        withCredentials: false,
      }
    };
  },

  interpretResponse: function (serverResponse, bidRequest) {
    if (!serverResponse.body) return [];

    const responseBody = {...serverResponse.body, seatbid: serverResponse.body.seatbid};
    const prebidBidResponse = converter.fromORTB({
      request: bidRequest.data.ortb,
      response: responseBody,
    });

    console.log({ serverResponse, bidRequest, prebidBidResponse });
    return prebidBidResponse.bids;
  },

};
registerBidder(spec);
