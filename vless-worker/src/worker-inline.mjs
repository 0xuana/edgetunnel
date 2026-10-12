import { createWorker } from './router.mjs';

// This request-scoped connector is exposed by workerd, but is not documented as
// the public Workers TCP API. The official-module build remains available.
export default createWorker(request => {
  const fetcher = request.fetcher;
  if (!fetcher || typeof fetcher.connect !== 'function') return null;
  return (address, options) => options === undefined ? fetcher.connect(address) : fetcher.connect(address, options);
});
