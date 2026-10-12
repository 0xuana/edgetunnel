import { connect } from 'cloudflare:sockets';
import { createWorker } from './router.mjs';

export default createWorker(() => connect);
