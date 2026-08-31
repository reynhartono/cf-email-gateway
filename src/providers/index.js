/**
 * Provider registry — delivery paths.
 */

export { cfForward } from "./cf_forward.js";
export { smtpSend, hasSmtp } from "./smtp.js";
export { sendOutboundMime, buildComposeMime } from "./send_outbound.js";
