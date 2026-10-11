import {readFileSync} from 'node:fs';
import {z} from 'zod';

// Package metadata is the single version source; CI/operator gates bind the same
// literal value to the Git tag, image tag and OCI metadata before publication.
const metadata=z.object({name:z.literal('stadtstack-data'),version:z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)}).parse(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')));
export const MCP_RELEASE_VERSION=metadata.version;
