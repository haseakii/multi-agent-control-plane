import { createFleetMcpHttpProxyServer, fleetProxyOptionsFromEnvironment } from './http-proxy.js';
import { serveFleetMcpStdio } from './server.js';

const server = await createFleetMcpHttpProxyServer(fleetProxyOptionsFromEnvironment());
await serveFleetMcpStdio(server);
