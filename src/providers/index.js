/**
 * Provider registry — delivery paths.
 */

export { cfForward } from "./cf_forward.js";
export { smtpSend, hasSmtp, bareEmail } from "./smtp.js";
export {
  sendOutboundMime,
  buildComposeMime,
  assertHeaderName,
  sanitizeHeaderValue,
  assertNoHeaderControlChars,
  sanitizeAttachmentFilename,
  sanitizeContentType,
  composeMimeError,
} from "./send_outbound.js";
