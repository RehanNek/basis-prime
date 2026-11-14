// The states /perps/sample can show. A file of its own, so the page (which runs on the server) and the view (which
// runs in the browser) can both read the list.
export const STATES = ['live', 'thin', 'empty', 'down', 'expired', 'slow', 'far'] as const;
export type SampleState = (typeof STATES)[number];
