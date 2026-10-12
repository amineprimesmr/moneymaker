#!/usr/bin/env node
// Copies the native MoneyMaker SDK sources (sdk/ios, sdk/android) into this package so the
// CocoaPod and Gradle module compile them directly. Run automatically on `prepare`.
// When the package is installed from npm the copies are already in the tarball: nothing to do.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sdk = path.resolve(root, '..');
const jobs = [
  { from: path.join(sdk, 'ios/Sources/MoneyMaker'), to: path.join(root, 'ios/MoneyMakerCore'), files: ['Models.swift', 'MoneyMaker.swift'] },
  { from: path.join(sdk, 'android/moneymaker/src/main/java/io/moneymaker'), to: path.join(root, 'android/src/main/java/io/moneymaker'), files: ['Models.kt', 'MoneyMaker.kt'] },
];

for (const job of jobs) {
  if (!fs.existsSync(job.from)) {
    console.log(`[moneymaker] ${job.from} not found, keeping bundled native sources.`);
    continue;
  }
  fs.mkdirSync(job.to, { recursive: true });
  for (const f of job.files) {
    fs.copyFileSync(path.join(job.from, f), path.join(job.to, f));
  }
  console.log(`[moneymaker] synced ${job.files.join(', ')} -> ${path.relative(root, job.to)}`);
}
