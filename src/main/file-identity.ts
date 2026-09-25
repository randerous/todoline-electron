import type {Stats} from 'node:fs';
export const fileIdentity=(stat:Stats)=>`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
