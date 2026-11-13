import { registerHooks } from "node:module";
// Test-process-only replacement of the native keyring. No production test flag,
// no plaintext credential file, and no access to the workstation credential store.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@napi-rs/keyring")
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `const entries=new Map();export class Entry {constructor(service,user){this.id=service+user;}setPassword(value){if(value==='fixture-store-denied')throw new Error('Store unavailable');entries.set(this.id,value);}getPassword(){return entries.get(this.id)??null;}deletePassword(){if(entries.get(this.id)==='fixture-delete-denied')throw new Error('Store failure with fixture-delete-denied');return entries.delete(this.id);}}`,
          ),
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
