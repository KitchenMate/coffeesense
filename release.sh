#!/bin/bash
set -e

# increase package.json version field beforehand in both . and ./server

# update changelog

cd server
yarn preversion
npm publish
cd ..
yarn compile
yarn prepare-publish 
rm -rf server/node_modules/coffeescript/{docs,documentation,.github,test,src} && exit 0
rm -rf server/node_modules/coffeescript/lib/{coffeescript,coffeescript-browser-compiler-legacy} && exit 0
vsce package
vsce publish
git push origin master
yarn
sed -i 's/debugger;/\/\/ debugger;/' /b/coffeesense/server/node_modules/typescript/lib/typescript.js