import {cpSync, mkdirSync, rmSync} from 'node:fs';
import {resolve} from 'node:path';

const source = resolve('node_modules/openseadragon/build/openseadragon/images');
const destination = resolve('public/openseadragon/images');
rmSync(destination, {recursive: true, force: true});
mkdirSync(destination, {recursive: true});
cpSync(source, destination, {recursive: true});
