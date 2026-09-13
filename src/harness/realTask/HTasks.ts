import * as fs from 'fs';
import * as path from 'path';
import type { RealTask, TaskEnvironment } from './RealTaskTypes';

export const H1_RegexEscape: RealTask = {
  taskId: 'H1_regex_escape',
  description: 'Regex uses unescaped dot - matches any char instead of literal dot - novel regex error',
  domain: 'replan',
  goalDescription: 'Fix match.js so matchVersion("v1.2.3") returns true (dot should match literal dot)',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(path.join(env.tempDir, 'match.js'), 'function matchVersion(s){return /^v1.2.3$/.test(s);}\nmodule.exports={matchVersion};\n');
    fs.writeFileSync(path.join(env.tempDir, 'match_test.js'), 'const {matchVersion}=require("./match");\nconst assert=require("assert");\nassert.strictEqual(matchVersion("v1.2.3"),true,"v1.2.3 should match");\nassert.strictEqual(matchVersion("v1X2Y3"),false,"v1X2Y3 should not match");\nconsole.log("PASS");\n');
  },
  successCriteria: {
    description: 'matchVersion("v1.2.3")===true && matchVersion("v1X2Y3")===false',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node match_test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
        return { satisfied: true, evidence: 'regex escape fixed - literal dot matching' };
      } catch (e: any) {
        return { satisfied: false, evidence: 'regex test fails: ' + e.message };
      }
    },
  },
};

export const H2_DeepPropertyAccess: RealTask = {
  taskId: 'H2_deep_property_access',
  description: 'Deep property access on null intermediate - novel null pointer error',
  domain: 'replan',
  goalDescription: 'Fix config.js so getDbHost() returns "localhost" instead of throwing TypeError',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(path.join(env.tempDir, 'config.js'), 'const cfg={server:{host:"localhost"}};\nfunction getDbHost(){return cfg.database.host;}\nmodule.exports={getDbHost};\n');
    fs.writeFileSync(path.join(env.tempDir, 'config_test.js'), 'const {getDbHost}=require("./config");\nconst assert=require("assert");\nassert.strictEqual(getDbHost(),"localhost","getDbHost() should return localhost");\nconsole.log("PASS");\n');
  },
  successCriteria: {
    description: 'getDbHost() === "localhost" without TypeError',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node config_test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
        return { satisfied: true, evidence: 'deep property access fixed - null pointer resolved' };
      } catch (e: any) {
        return { satisfied: false, evidence: 'config test fails: ' + e.message };
      }
    },
  },
};

export const H3_ArrayMutation: RealTask = {
  taskId: 'H3_array_mutation',
  description: 'Function mutates input array via sort - novel side-effect error',
  domain: 'replan',
  goalDescription: 'Fix sort.js so getSorted() returns sorted copy without mutating original array',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(path.join(env.tempDir, 'sort.js'), 'function getSorted(arr){return arr.sort();}\nmodule.exports={getSorted};\n');
    fs.writeFileSync(path.join(env.tempDir, 'sort_test.js'), 'const {getSorted}=require("./sort");\nconst assert=require("assert");\nconst original=[3,1,2];\nconst sorted=getSorted(original);\nassert.deepStrictEqual(sorted,[1,2,3],"sorted should be [1,2,3]");\nassert.deepStrictEqual(original,[3,1,2],"original should not be mutated");\nconsole.log("PASS");\n');
  },
  successCriteria: {
    description: 'getSorted returns sorted copy, original not mutated',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node sort_test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
        return { satisfied: true, evidence: 'array mutation fixed - sort returns copy' };
      } catch (e: any) {
        return { satisfied: false, evidence: 'sort test fails: ' + e.message };
      }
    },
  },
};

export const H4_FloatComparison: RealTask = {
  taskId: 'H4_float_comparison',
  description: 'Direct float equality comparison fails due to precision - novel floating point error',
  domain: 'replan',
  goalDescription: 'Fix math.js so isEqual(0.1+0.2, 0.3) returns true using epsilon comparison',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(path.join(env.tempDir, 'math.js'), 'function isEqual(a,b){return a===b;}\nmodule.exports={isEqual};\n');
    fs.writeFileSync(path.join(env.tempDir, 'math_test.js'), 'const {isEqual}=require("./math");\nconst assert=require("assert");\nassert.strictEqual(isEqual(0.1+0.2,0.3),true,"0.1+0.2 should equal 0.3");\nassert.strictEqual(isEqual(1.0,1.0),true,"1.0 should equal 1.0");\nconsole.log("PASS");\n');
  },
  successCriteria: {
    description: 'isEqual(0.1+0.2, 0.3)===true with epsilon comparison',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node math_test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
        return { satisfied: true, evidence: 'float comparison fixed - epsilon comparison used' };
      } catch (e: any) {
        return { satisfied: false, evidence: 'math test fails: ' + e.message };
      }
    },
  },
};

export const H5_ScopeLeak: RealTask = {
  taskId: 'H5_scope_leak',
  description: 'Variable declared without var/let/const leaks to global scope - novel scope error',
  domain: 'replan',
  goalDescription: 'Fix counter.js so increment() does not pollute global scope with counter variable',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(path.join(env.tempDir, 'counter.js'), 'function increment(){counter=(typeof counter==="undefined")?0:counter;counter++;return counter;}\nmodule.exports={increment};\n');
    fs.writeFileSync(path.join(env.tempDir, 'counter_test.js'), 'const {increment}=require("./counter");\nconst assert=require("assert");\nassert.strictEqual(increment(),1,"first increment should be 1");\nassert.strictEqual(increment(),2,"second increment should be 2");\nassert.strictEqual(typeof global.counter,"undefined","counter should not be global");\nconsole.log("PASS");\n');
  },
  successCriteria: {
    description: 'increment() works correctly and counter is not on global',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node counter_test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
        return { satisfied: true, evidence: 'scope leak fixed - counter is local' };
      } catch (e: any) {
        return { satisfied: false, evidence: 'counter test fails: ' + e.message };
      }
    },
  },
};

export const H6_PromiseUnhandled: RealTask = {
  taskId: 'H6_promise_unhandled',
  description: 'Promise rejection not caught - novel async error handling',
  domain: 'replan',
  goalDescription: 'Fix fetch.js so getData() catches the Promise rejection and returns null instead of throwing',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(path.join(env.tempDir, 'fetch.js'), 'function getData(){return Promise.reject(new Error("network error"));}\nmodule.exports={getData};\n');
    fs.writeFileSync(path.join(env.tempDir, 'fetch_test.js'), 'const {getData}=require("./fetch");\ngetData().then(r=>{const assert=require("assert");assert.strictEqual(r,null,"should return null on error");console.log("PASS");}).catch(e=>{console.error("UNHANDLED:",e.message);process.exit(1);});\n');
  },
  successCriteria: {
    description: 'getData() catches rejection and returns null',
    check: async (env: TaskEnvironment) => {
      try {
        const content = fs.readFileSync(path.join(env.tempDir, 'fetch.js'), 'utf-8');
        if (!content.includes('catch') && !content.includes('.catch') && !content.includes('try')) {
          return { satisfied: false, evidence: 'fetch.js does not handle Promise rejection' };
        }
        const { execSync } = require('child_process');
        execSync('node fetch_test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
        return { satisfied: true, evidence: 'Promise rejection handled - returns null on error' };
      } catch (e: any) {
        return { satisfied: false, evidence: 'fetch test fails: ' + e.message };
      }
    },
  },
};

export const D9_TEST_BATCH: RealTask[] = [
  H1_RegexEscape,
  H2_DeepPropertyAccess,
  H3_ArrayMutation,
  H4_FloatComparison,
  H5_ScopeLeak,
  H6_PromiseUnhandled,
];
