import { EXTENSION_API_VERSION, type ExtensionManifest } from '../../../shared/extensions.ts';
import { communicationsManifest } from '../../../shared/extensions/project-communications/manifest.ts';

export class ExtensionRegistry {
  private entries = new Map<string,ExtensionManifest>();
  register(manifest:ExtensionManifest) {
    if(manifest.apiVersion!==EXTENSION_API_VERSION)throw Error('extension_api_incompatible');
    if(!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.id)||this.entries.has(manifest.id))throw Error('extension_registration_invalid');
    this.entries.set(manifest.id,Object.freeze({...manifest}));
  }
  get(id:string) {const value=this.entries.get(id);if(!value)throw Error('extension_not_registered');return value;}
  list() {return [...this.entries.values()];}
}
export function builtinExtensionRegistry() {const registry=new ExtensionRegistry();registry.register(communicationsManifest);return registry;}
