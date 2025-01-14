const IIIF = require('iiif-processor');
const debug = require('debug')('serverless-iiif:lambda');
const helpers = require('./helpers');
const resolvers = require('./resolvers');
const { errorHandler } = require('./error');
const { streamifyResponse } = require('./streamify');

const handleRequestFunc = streamifyResponse(async (event, context) => {
  debug('http path: ', event?.requestContext?.http?.path);
  const { addCorsHeaders, eventPath, fileMissing } = helpers;

  context.callbackWaitsForEmptyEventLoop = false;

  let response;
  if (event.requestContext?.http?.method === 'OPTIONS') {
    // OPTIONS REQUEST
    response = { statusCode: 204, body: null };
  } else if (event?.requestContext?.http?.path === '/') {
    response = handleServiceDiscoveryRequestFunc();
  } else if (/^\/iiif\/\d+\/?$/.test(event?.requestContext?.http?.path)) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/plain'
      },
      isBase64Encoded: false,
      body: 'OK'
    };
  } else if (fileMissing(event)) {
    // INFO.JSON REQUEST
    const location = eventPath(event) + '/info.json';
    response = { statusCode: 302, headers: { Location: location }, body: 'Redirecting to info.json' };
  } else {
    // IMAGE REQUEST
    response = await handleResourceRequestFunc(event, context);
  }
  return addCorsHeaders(event, response);
});

const handleServiceDiscoveryRequestFunc = () => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json'
    },
    isBase64Encoded: false,
    body: JSON.stringify({
      links: [
        {
          href: '/iiif/2/{:id}',
          name: 'IIIF Image API v2 endpoint'
        },
        {
          href: '/iiif/3/{:id}',
          name: 'IIIF Image API v3 endpoint'
        }
      ],
      versions: { ...require('sharp').versions }
    })
  };
};

const executeResource = async (uri, streamResolver, dimensionFunction, density, sharpOptions = {}) => {
  try {
    const debugBorder = process.env.debugBorder === 'true';
    const pageThreshold = parseInt(process.env.pageThreshold) || undefined;
    const resource = new IIIF.Processor(uri, streamResolver, { dimensionFunction, density, debugBorder, pageThreshold, sharpOptions });
    return await resource.execute();
  } catch (err) {
    if (/Invalid tile part index/.test(err.message) && !sharpOptions.jp2Oneshot) {
      console.log('Encountered JP2 tile part index error. Trying oneshot load.');
      return await executeResource(uri, streamResolver, dimensionFunction, density, { ...sharpOptions, jp2Oneshot: true });
    }
    throw err;
  }
};

const handleResourceRequestFunc = async (event, context) => {
  const density = helpers.parseDensity(process.env.density);
  const { getUri } = helpers;
  const preflight = process.env.preflight === 'true';
  const { streamResolver, dimensionResolver } = resolvers.resolverFactory(event, preflight);

  let resource;
  try {
    const uri = getUri(event);
    const result = await executeResource(uri, streamResolver, dimensionResolver, density);
    return makeResponse(result);
  } catch (err) {
    return errorHandler(err, event, context, resource);
  }
};

const makeResponse = (result) => {
  const linkHeaders = ['canonical', 'profile']
    .map((rel) => {
      return { rel, property: `${rel}Link` };
    })
    .filter(({ property }) => result[property])
    .map(({ rel, property }) => `<${result[property]}>; rel=${rel}`);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': result.contentType,
      Link: linkHeaders.length > 0 ? linkHeaders.join(',') : undefined
    },
    isBase64Encoded: false,
    body: result.body
  };
};

module.exports = {
  handler: handleRequestFunc
};
