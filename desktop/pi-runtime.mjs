// Only the agent worker needs the full session runtime. Use the official SDK
// implementation directly without evaluating its CLI and interactive entrypoints.
import {piModule} from './pi-core.mjs';
export {SettingsManager, SessionManager} from './pi-core.mjs';
const [sdk, models, resources, mutations] = await Promise.all([
  piModule('core/sdk.js'), piModule('core/model-runtime.js'),
  piModule('core/resource-loader.js'), piModule('core/tools/file-mutation-queue.js'),
]);
export const {createAgentSession} = sdk;
export const {ModelRuntime} = models;
export const {DefaultResourceLoader} = resources;
export const {withFileMutationQueue} = mutations;
