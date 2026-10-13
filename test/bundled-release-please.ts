// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as assert from 'assert';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join, resolve} from 'path';
import {afterEach, beforeEach, describe, it} from 'mocha';
import mockedEnv, {RestoreFn} from 'mocked-env';
import * as sinon from 'sinon';

const {Response} = require('node-fetch');
// Exercise the committed artifact used by action.yml, including its own copy
// of release-please, rather than the source entry point or node_modules copy.
const action = require(resolve(__dirname, '../../dist/index.js'));

describe('bundled release-please-action', () => {
  const sandbox = sinon.createSandbox();
  const tagName = '@example/widget-v1.0.0';
  const releaseSha = '0123456789abcdef0123456789abcdef01234567';
  let directory: string;
  let outputPath: string;
  let restoreEnv: RestoreFn;
  let stdout: sinon.SinonStub;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'release-please-action-'));
    outputPath = join(directory, 'outputs');
    writeFileSync(outputPath, '');
    restoreEnv = mockedEnv({
      GITHUB_OUTPUT: outputPath,
      INPUT_TOKEN: 'fake-token',
      'INPUT_REPO-URL': 'fake-owner/fake-repo',
      'INPUT_TARGET-BRANCH': 'main',
      'INPUT_SKIP-GITHUB-RELEASE': 'true',
      'INPUT_SKIP-GITHUB-PULL-REQUEST': 'false',
      'INPUT_RELEASE-TYPE': '',
      'INPUT_CONFIG-FILE': 'release-please-config.json',
      'INPUT_MANIFEST-FILE': '.release-please-manifest.json',
      'INPUT_GITHUB-API-URL': '',
      'INPUT_GITHUB-GRAPHQL-URL': '',
      'INPUT_CHANGELOG-HOST': '',
      'INPUT_PROXY-SERVER': '',
      INPUT_FORK: '',
      'INPUT_SKIP-LABELING': '',
    });
    stdout = sandbox.stub(process.stdout, 'write').returns(true);
    sandbox.stub(console, 'warn');
  });

  afterEach(() => {
    sandbox.restore();
    restoreEnv();
    rmSync(directory, {recursive: true, force: true});
  });

  for (const annotated of [false, true]) {
    it(`resolves a missing release using an exact scoped ${
      annotated ? 'annotated' : 'lightweight'
    } tag`, async () => {
      const requests: string[] = [];
      const fetch = async (
        url: string,
        options: {method?: string; body?: string}
      ) => {
        const path = decodeURIComponent(new URL(url).pathname);
        const method = options.method || 'GET';
        requests.push(`${method} ${path}`);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            headers: {'content-type': 'application/json'},
          });
        const contents = (body: unknown) =>
          json({
            sha: 'file-sha',
            encoding: 'base64',
            content: Buffer.from(JSON.stringify(body)).toString('base64'),
          });

        if (method === 'GET') {
          if (path === '/repos/fake-owner/fake-repo/git/ref/heads/main') {
            return json({
              ref: 'refs/heads/main',
              object: {type: 'commit', sha: releaseSha},
            });
          }
          if (path === `/repos/fake-owner/fake-repo/git/trees/${releaseSha}`) {
            return json({
              truncated: false,
              tree: [
                {
                  path: 'release-please-config.json',
                  type: 'blob',
                  mode: '100644',
                  sha: 'config-sha',
                },
                {
                  path: '.release-please-manifest.json',
                  type: 'blob',
                  mode: '100644',
                  sha: 'manifest-sha',
                },
              ],
            });
          }
          if (path === '/repos/fake-owner/fake-repo/git/blobs/config-sha') {
            return contents({
              packages: {
                '.': {
                  'release-type': 'simple',
                  component: '@example/widget',
                  'include-component-in-tag': true,
                },
              },
            });
          }
          if (path === '/repos/fake-owner/fake-repo/git/blobs/manifest-sha') {
            return contents({'.': '1.0.0'});
          }
          if (path === `/repos/fake-owner/fake-repo/git/ref/tags/${tagName}`) {
            return json({
              ref: `refs/tags/${tagName}`,
              object: annotated
                ? {type: 'tag', sha: 'outer-annotation'}
                : {type: 'commit', sha: releaseSha},
            });
          }
          if (
            annotated &&
            path === '/repos/fake-owner/fake-repo/git/tags/outer-annotation'
          ) {
            return json({object: {type: 'tag', sha: 'inner-annotation'}});
          }
          if (
            annotated &&
            path === '/repos/fake-owner/fake-repo/git/tags/inner-annotation'
          ) {
            return json({object: {type: 'commit', sha: releaseSha}});
          }
        }
        if (method === 'POST' && path === '/graphql') {
          const {query, variables} = JSON.parse(options.body || '{}');
          if (query.includes('query releases(')) {
            return json({
              data: {repository: {releases: {nodes: []}}},
            });
          }
          if (query.includes('query pullRequestsSince(')) {
            assert.ok(query.includes('object(expression: $targetBranch)'));
            assert.strictEqual(variables.targetBranch, releaseSha);
            return json({
              data: {
                repository: {
                  object: {
                    history: {
                      nodes: [
                        {
                          sha: releaseSha,
                          message: 'chore: release 1.0.0',
                          associatedPullRequests: {
                            nodes: [
                              {
                                number: 20,
                                title: 'chore: release 1.0.0',
                                body: '',
                                baseRefName: 'main',
                                headRefName: 'release-please--branches--main',
                                mergeCommit: {oid: releaseSha},
                                labels: {nodes: []},
                                files: {
                                  nodes: [],
                                  pageInfo: {hasNextPage: false},
                                },
                              },
                            ],
                          },
                        },
                      ],
                      pageInfo: {hasNextPage: false},
                    },
                  },
                },
              },
            });
          }
        }
        throw new Error(`Unexpected bundled action request: ${method} ${path}`);
      };

      await action.main(fetch);

      sinon.assert.calledWithMatch(
        stdout,
        'Running release-please version: 17.11.2'
      );
      assert.strictEqual(
        requests.filter(
          request =>
            request === 'GET /repos/fake-owner/fake-repo/git/ref/heads/main'
        ).length,
        1
      );
      // Concurrent config/manifest loads can fetch the same tree more than once.
      // Every request must still use the pinned source commit.
      const treeReads = requests.filter(request =>
        request.startsWith('GET /repos/fake-owner/fake-repo/git/trees/')
      );
      assert.ok(treeReads.length > 0);
      assert.ok(
        treeReads.every(
          request =>
            request ===
            `GET /repos/fake-owner/fake-repo/git/trees/${releaseSha}`
        )
      );
      assert.strictEqual(
        requests.filter(request => request.includes('/git/tags/')).length,
        annotated ? 2 : 0
      );
      assert.strictEqual(
        requests.filter(
          request =>
            request ===
            `GET /repos/fake-owner/fake-repo/git/ref/tags/${tagName}`
        ).length,
        1
      );
      assert.match(
        readFileSync(outputPath, 'utf8'),
        /^prs_created<<[^\r\n]+\r?\nfalse\r?\n/
      );
    });
  }
});
