export const extension_settings = {};

export function getContext() {
    const ctx = globalThis.__ST;
    if (!ctx) {
        throw new Error('[test] globalThis.__ST is not set');
    }
    return ctx;
}
