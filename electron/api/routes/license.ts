import type { IncomingMessage, ServerResponse } from 'http';
import { activateLicenseCode, getLicenseStatus } from '../../utils/license';
import { parseJsonBody, sendJson } from '../route-utils';
import type { HostApiContext } from '../context';

export async function handleLicenseRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/license/status' && req.method === 'GET') {
    sendJson(res, 200, await getLicenseStatus());
    return true;
  }

  if (url.pathname === '/api/license/activate' && req.method === 'POST') {
    const body = await parseJsonBody<{ code?: string }>(req);
    const code = typeof body.code === 'string' ? body.code : '';
    const status = await activateLicenseCode(code);
    if (status.activated) {
      sendJson(res, 200, { success: true, ...status });
    } else {
      sendJson(res, 400, { success: false, ...status });
    }
    return true;
  }

  return false;
}
