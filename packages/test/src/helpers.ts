import path from 'path';
import StackUtils from 'stack-utils';
import ava, { TestFn } from 'ava';
import * as grpc from '@grpc/grpc-js';
import asyncRetry from 'async-retry';
import { v4 as uuid4 } from 'uuid';
import { inWorkflowContext } from '@temporalio/workflow';
import { Payload, PayloadCodec } from '@temporalio/common';
import { Worker as RealWorker, WorkerOptions } from '@temporalio/worker';
import * as worker from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import * as iface from '@temporalio/proto';

export function u8(s: string): Uint8Array {
  // TextEncoder requires lib "dom"
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  return new TextEncoder().encode(s);
}

export function isSet(env: string | undefined): boolean {
  if (env === undefined) return false;
  env = env.toLocaleLowerCase();
  return env === '1' || env === 't' || env === 'true';
}

export const RUN_INTEGRATION_TESTS = inWorkflowContext() || isSet(process.env.RUN_INTEGRATION_TESTS);
export const REUSE_V8_CONTEXT = inWorkflowContext() || isSet(process.env.REUSE_V8_CONTEXT);

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cleanOptionalStackTrace(stackTrace: string | undefined | null): string | undefined {
  return stackTrace ? cleanStackTrace(stackTrace) : undefined;
}

/**
 * Relativize paths and remove line and column numbers from stack trace
 */
export function cleanStackTrace(ostack: string): string {
  // For some reason, a code snippet with carret on error location is sometime prepended before the actual stacktrace.
  // If there is such a snippet, get rid of it.
  const stack = ostack.replace(/^.*\n[ ]*\^[ ]*\n+/gms, '');

  const su = new StackUtils({ cwd: path.join(__dirname, '../..') });
  const firstLine = stack.split('\n')[0];
  const cleanedStack = su.clean(stack).trimEnd();
  const normalizedStack =
    cleanedStack &&
    cleanedStack
      .replace(/:\d+:\d+/g, '')
      .replace(/^\s*/gms, '    at ')
      .replace(/\[as fn\] /, '')
      .replace(/\\/g, '/');

  return normalizedStack ? `${firstLine}\n${normalizedStack}` : firstLine;
}

function noopTest() {
  // eslint: this function body is empty and it's okay.
}

noopTest.serial = () => undefined;
noopTest.macro = () => undefined;
noopTest.before = () => undefined;
noopTest.after = () => undefined;
(noopTest.after as any).always = () => undefined;
noopTest.beforeEach = () => undefined;
noopTest.afterEach = () => undefined;

/**
 * (Mostly complete) helper to allow mixing workflow and non-workflow code in the same test file.
 */
export const test: TestFn<unknown> = inWorkflowContext() ? (noopTest as any) : ava;

export const bundlerOptions = {
  // This is a bit ugly but it does the trick, when a test that includes workflow code tries to import a forbidden
  // workflow module, add it to this list:
  ignoreModules: [
    '@temporalio/common/lib/internal-non-workflow',
    '@temporalio/activity',
    '@temporalio/client',
    '@temporalio/testing',
    '@temporalio/worker',
    'ava',
    'crypto',
    'module',
    'path',
    'stack-utils',
    '@grpc/grpc-js',
    'async-retry',
    'uuid',
  ],
};

/**
 * A PayloadCodec used for testing purposes, skews the bytes in the payload data by 1
 */
export class ByteSkewerPayloadCodec implements PayloadCodec {
  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => ({
      ...payload,
      data: payload.data?.map((byte) => byte + 1),
    }));
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => ({
      ...payload,
      data: payload.data?.map((byte) => byte - 1),
    }));
  }
}

// Hack around Worker not being available in workflow context
if (inWorkflowContext()) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  worker.Worker = class {}; // eslint-disable-line import/namespace
}

export class Worker extends worker.Worker {
  static async create(options: WorkerOptions): Promise<worker.Worker> {
    return RealWorker.create({ ...options, reuseV8Context: REUSE_V8_CONTEXT });
  }
}

// Some of our tests expect "default custom search attributes" to exists, which used to be the case
// in all deployment with support for advanced visibility. However, this might no longer be true in
// some environement (e.g. Temporal CLI). Use the operator service to create them if they're missing.
export async function registerDefaultCustomSearchAttributes(connection: Connection): Promise<void> {
  const client = new Client({ connection }).workflow;
  console.log(`Registering custom search attributes...`);
  const startTime = Date.now();
  try {
    await connection.operatorService.addSearchAttributes({
      namespace: 'default',
      searchAttributes: {
        CustomIntField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_INT,
        CustomBoolField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_BOOL,
        CustomKeywordField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
        CustomTextField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_TEXT,
        CustomDatetimeField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_DATETIME,
        CustomDoubleField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_DOUBLE,
      },
    });
  } catch (err: any) {
    if (err.code !== grpc.status.ALREADY_EXISTS) {
      throw err;
    }
  }
  // The initialization of the custom search attributes is slooooow. Wait for it to finish
  await asyncRetry(
    async () => {
      try {
        // We simply _try_ to schedule a workflow that uses some custom search attributes.
        // The call will fail immediately if the SA are not registered yet. Note that the workflow
        // will actually never execute (ie. no worker is listing to that queue and workflow type
        // doesn't exist). It will just end up being terminated because of a timeout.
        const handle = await client.start('wait-for-default-custom-search-attributes', {
          workflowId: uuid4(),
          taskQueue: 'no_one_cares_pointless_queue',
          workflowExecutionTimeout: 1000,
          searchAttributes: { CustomIntField: [1] },
        });
        await handle.terminate();
      } catch (e: any) {
        // Continue until we see an error that *isn't* about the SA being invalid
        if (!e.cause.details.includes('CustomIntField')) {
          return;
        }
        throw e;
      }
    },
    {
      retries: 60,
      maxTimeout: 1000,
    }
  );
  const timeTaken = Date.now() - startTime;
  console.log(`... Registered (took ${timeTaken / 1000} sec)!`);
}
