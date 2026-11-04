import { reactive } from 'vue';

/** Bind only the state object; private controller fields retain their class identity. */
export function reactiveBind<T extends object>(state: T): T { return reactive(state) as T; }
