var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/@gfld/compositor-proxy-cli/src/SessionProcess.ts
var SessionProcess_exports = {};
module.exports = __toCommonJS(SessionProcess_exports);
var import_compositor_proxy = require("@gfld/compositor-proxy");
process.on("uncaughtException", (e) => {
  logger.error("	name: " + e.name + " message: " + e.message);
  logger.error("error object stack: ");
  logger.error(e.stack ?? "");
});
var logger = (0, import_compositor_proxy.createLogger)("session-process");
function isIpcMessage(message) {
  return message.type === "start" || message.type === "stop" || message.type === "launchApp" || message.type === "wsUpgrade";
}
process.on("message", (message, sendHandle) => {
  if (isIpcMessage(message)) {
    switch (message.type) {
      case "start":
        start(message.payload);
        break;
      case "launchApp":
        launchApp(message.payload);
        break;
      case "wsUpgrade":
        wsUpgrade(message.payload, sendHandle);
        break;
    }
  } else {
    throw new Error(`BUG. received message is not an IPC message. Got: ${JSON.stringify(message)})`);
  }
});
var context = void 0;
function start({ config, compositorSessionId }) {
  if (context !== void 0) {
    throw new Error("BUG. Already started");
  }
  (0, import_compositor_proxy.initSurfaceBufferEncoding)();
  const session = (0, import_compositor_proxy.createSession)(compositorSessionId, config);
  const sessionController = (0, import_compositor_proxy.createSessionController)(session);
  context = {
    session,
    sessionController
  };
  session.closeListeners.push(() => {
    process.exit();
  });
  logger.info(`Session started.`);
}
async function launchApp({
  serial,
  name,
  executable,
  args,
  env
}) {
  if (context === void 0) {
    throw new Error("BUG. Not yet started");
  }
  try {
    const nativeAppContext = await (0, import_compositor_proxy.launchApplication)(name, executable, args, env, context.session);
    nativeAppContext.onDisconnect();
    const launchAppSuccess = {
      type: "launchAppSuccess",
      payload: { replySerial: serial, pid: `${nativeAppContext.pid}`, key: nativeAppContext.key }
    };
    process.send(launchAppSuccess);
  } catch (e) {
    const launchAppFailed = {
      type: "launchAppFailed",
      payload: { replySerial: serial, message: e.message }
    };
    process.send(launchAppFailed);
  }
}
function wsUpgrade({ request }, socket) {
  if (context === void 0) {
    throw new Error("BUG. Not yet started");
  }
  socket.resume();
  context.sessionController.onWsUpgrade(request, socket);
}
