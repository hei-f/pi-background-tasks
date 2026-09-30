import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { isAbsolute } from 'node:path';
import { appendErrorText, boundedErrorMessage, deriveTerminalStatus, errorMessage, isEnospcError, snapshot, writeTaskOutputChunk, ReloadSurvivalError, } from './common.js';
import { collectPosixDescendantPids as collectPosixDescendantPidsDefault, POSIX_DESCENDANT_COLLECT_DELAY_MS, } from './process-tree.js';
import { parseTelemetryStream } from './telemetry.js';
import { replaceFileDurable } from './durable-fs.js';
import { runWindowsTaskkill, } from './windows-taskkill.js';
export const RELOAD_SHELL_OWNER_PROTOCOL = 'pi-background-tasks.reload-shell-owner.v1';
export const RELOAD_SHELL_OWNER_SYMBOL = Symbol.for(RELOAD_SHELL_OWNER_PROTOCOL);
export const RELOAD_SHELL_HANDOFF_TIMEOUT_MS = 30_000;
export { ReloadSurvivalError } from './common.js';
const hubStates = new WeakMap();
const OWNER_STATE_SYMBOL = Symbol.for(`${RELOAD_SHELL_OWNER_PROTOCOL}.test-state`);
function ownerError(code, message) {
    return new ReloadSurvivalError(code, message);
}
function randomNonce() {
    return randomBytes(16).toString('hex');
}
function requireNonce(value, label) {
    if (!/^[0-9a-f]{32}$/u.test(value)) {
        throw ownerError('pi_bg_reload_owner_stale_claim', `${label} is not a 128-bit lowercase hex nonce`);
    }
}
function positiveTimeout(value, fallback) {
    const candidate = value ?? fallback;
    if (!Number.isFinite(candidate) || candidate <= 0) {
        throw ownerError('pi_bg_reload_owner_protocol_incompatible', 'handoff timeout must be positive');
    }
    return Math.max(1, Math.floor(candidate));
}
function lengthPart(value) {
    return `${String(Buffer.byteLength(value, 'utf8'))}:${value}`;
}
export function makeReloadShellIdentity(sessionId, cwdRealpath, hostPid = process.pid) {
    if (!Number.isSafeInteger(hostPid) || hostPid <= 0 || hostPid !== process.pid) {
        throw ownerError('pi_bg_reload_owner_stale_claim', `reload owner host pid must equal the current process pid ${String(process.pid)}`);
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw ownerError('pi_bg_reload_owner_stale_claim', 'reload owner session id must be non-empty');
    }
    if (typeof cwdRealpath !== 'string' || cwdRealpath.length === 0 || !isAbsolute(cwdRealpath)) {
        throw ownerError('pi_bg_reload_owner_stale_claim', 'reload owner cwd identity must be a non-empty absolute canonical path');
    }
    return Object.freeze({ hostPid, sessionId, cwdRealpath });
}
export function reloadShellIdentityKey(identity) {
    if (identity.hostPid !== process.pid) {
        throw ownerError('pi_bg_reload_owner_stale_claim', 'reload owner identity belongs to another process');
    }
    return `${lengthPart(String(identity.hostPid))}${lengthPart(identity.sessionId)}${lengthPart(identity.cwdRealpath)}`;
}
function structuralHub(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    if (Reflect.get(value, 'protocol') !== RELOAD_SHELL_OWNER_PROTOCOL)
        return false;
    if (typeof Reflect.get(value, 'hubNonce') !== 'string')
        return false;
    for (const method of [
        'beginActivation',
        'commitActivation',
        'abortActivation',
        'beginReloadHandoff',
        'releaseActivation',
        'registerExecution',
        'markAdmissionCommitted',
        'releaseExecution',
        'isCurrentLease',
    ]) {
        if (typeof Reflect.get(value, method) !== 'function')
            return false;
    }
    return true;
}
function sameIdentity(left, right) {
    return (left.hostPid === right.hostPid &&
        left.sessionId === right.sessionId &&
        left.cwdRealpath === right.cwdRealpath);
}
function clearHandoffTimer(slot) {
    if (slot.handoffTimer !== undefined) {
        clearTimeout(slot.handoffTimer);
        slot.handoffTimer = undefined;
    }
}
export function createReloadShellOwnerHubForTests(dependencies = {}) {
    const now = dependencies.now ?? Date.now;
    const nextNonce = dependencies.randomNonce ?? randomNonce;
    const logger = dependencies.logger ?? console;
    const handoffTimeoutMs = positiveTimeout(dependencies.handoffTimeoutMs, RELOAD_SHELL_HANDOFF_TIMEOUT_MS);
    const slots = new Map();
    const terminalReleaseContinuations = new WeakMap();
    const hubNonce = nextNonce();
    requireNonce(hubNonce, 'hub nonce');
    const failStale = (message) => {
        throw ownerError('pi_bg_reload_owner_stale_claim', message);
    };
    const currentSlotForLease = (lease) => {
        if (lease.protocol !== RELOAD_SHELL_OWNER_PROTOCOL || lease.hubNonce !== hubNonce) {
            return failStale('activation lease belongs to another owner protocol instance');
        }
        const slot = slots.get(lease.identityKey);
        if (slot === undefined ||
            slot.phase !== 'bound' ||
            slot.lease?.generation !== lease.generation ||
            slot.lease.activationNonce !== lease.activationNonce) {
            return failStale('activation lease is stale or no longer bound');
        }
        return slot;
    };
    const slotForClaim = (claim) => {
        if (claim.protocol !== RELOAD_SHELL_OWNER_PROTOCOL || claim.hubNonce !== hubNonce) {
            return failStale('activation claim belongs to another owner protocol instance');
        }
        const slot = slots.get(claim.identityKey);
        if (slot === undefined ||
            slot.phase !== 'claiming' ||
            slot.claim !== claim ||
            slot.claimNonce !== claim.claimNonce ||
            slot.generation !== claim.generation ||
            slot.activationNonce !== claim.activationNonce ||
            !sameIdentity(slot.identity, claim.identity)) {
            return failStale('activation claim is stale or no longer current');
        }
        if (claim.expiresAt !== undefined && now() >= claim.expiresAt) {
            return failStale('activation claim expired before mutation');
        }
        return slot;
    };
    const dispatch = (slot, kind, execution) => {
        if (slot.executions.get(execution.launchNonce) !== execution)
            return;
        const adapter = slot.adapter;
        if (slot.phase === 'releasing' && kind === 'terminal') {
            removeExecution(slot, execution);
            return;
        }
        if (slot.phase !== 'bound' || adapter === undefined) {
            if (kind === 'changed')
                slot.queuedChanged.add(execution.launchNonce);
            else
                slot.queuedTerminal.add(execution.launchNonce);
            return;
        }
        try {
            if (kind === 'changed')
                adapter.onChanged(execution);
            else
                adapter.onTerminal(execution);
        }
        catch (error) {
            logger.error(`[background-tasks] reload owner ${kind} adapter failed for ${execution.task.id}: ${boundedErrorMessage(error, 500)}`);
            if (kind === 'changed')
                slot.queuedChanged.add(execution.launchNonce);
            else
                slot.queuedTerminal.add(execution.launchNonce);
        }
    };
    function removeExecution(slot, execution) {
        if (slot.executions.get(execution.launchNonce) !== execution)
            return;
        slot.executions.delete(execution.launchNonce);
        slot.queuedChanged.delete(execution.launchNonce);
        slot.queuedTerminal.delete(execution.launchNonce);
        execution.setOwnerEventSink(undefined);
        execution.releaseResources();
        if (slot.executions.size === 0 &&
            (slot.phase === 'handoff' || slot.phase === 'releasing' || slot.phase === 'orphaned')) {
            clearHandoffTimer(slot);
            slots.delete(slot.identityKey);
        }
    }
    const releaseAfterTerminal = (slot, execution) => {
        const existing = terminalReleaseContinuations.get(execution);
        if (existing !== undefined)
            return existing;
        const continuation = execution.terminal.then(() => {
            if (slots.get(slot.identityKey) !== slot ||
                slot.executions.get(execution.launchNonce) !== execution) {
                return;
            }
            if (execution.phase !== 'terminal') {
                logger.error(`[background-tasks] retained reload shell execution ${execution.task.id} settled without terminal ownership proof; keeping its owner slot`);
                return;
            }
            try {
                removeExecution(slot, execution);
            }
            catch (error) {
                logger.error(`[background-tasks] retained reload shell execution cleanup failed for ${execution.task.id}: ${boundedErrorMessage(error, 500)}`);
            }
        }, (error) => {
            logger.error(`[background-tasks] retained reload shell execution terminal promise rejected for ${execution.task.id}; keeping its owner slot: ${boundedErrorMessage(error, 500)}`);
        });
        terminalReleaseContinuations.set(execution, continuation);
        return continuation;
    };
    const expireHandoff = (slot, deadline) => {
        if (slots.get(slot.identityKey) !== slot)
            return;
        if ((slot.phase !== 'handoff' && slot.phase !== 'claiming') ||
            slot.expiresAt !== deadline ||
            now() < deadline) {
            return;
        }
        slot.phase = 'orphaned';
        slot.adapter = undefined;
        slot.claim = undefined;
        delete slot.claimNonce;
        clearHandoffTimer(slot);
        const executions = [...slot.executions.values()];
        void Promise.allSettled(executions.map(async (execution) => {
            execution.abandonReloadHandoff();
            const terminalRelease = releaseAfterTerminal(slot, execution);
            try {
                if (execution.phase === 'running' || execution.phase === 'stop_requested') {
                    await execution.requestStop('handoff_expired', `pi_bg_reload_handoff_expired: no compatible reload activation claimed the live shell execution before the ${String(handoffTimeoutMs)}ms handoff deadline`);
                }
                else if (execution.phase === 'starting') {
                    execution.failAdmission(ownerError('pi_bg_reload_handoff_expired', 'uncommitted reload shell execution reached handoff expiry'));
                    await execution.requestStop('handoff_expired');
                }
                else if (execution.phase === 'finalizing') {
                    await execution.terminal;
                }
            }
            catch (error) {
                logger.error(`[background-tasks] reload handoff expiry could not settle ${execution.task.id}: ${boundedErrorMessage(error, 500)}`);
            }
            await terminalRelease;
        })).then(() => {
            if (slots.get(slot.identityKey) === slot && slot.executions.size === 0) {
                slots.delete(slot.identityKey);
            }
        });
        logger.error(`[background-tasks] pi_bg_reload_handoff_expired: ${String(executions.length)} live reload shell execution(s) were not claimed before the fixed handoff deadline`);
    };
    const armHandoffDeadline = (slot) => {
        const deadline = slot.expiresAt;
        if (deadline === undefined || slot.handoffTimer !== undefined)
            return;
        const remaining = Math.max(0, deadline - now());
        slot.handoffTimer = setTimeout(() => {
            slot.handoffTimer = undefined;
            expireHandoff(slot, deadline);
        }, remaining);
        // Deliberately referenced. The retained child/tree authority must keep the
        // process alive until a claimant or orphan cleanup owns it.
    };
    const hub = Object.assign(Object.create(null), {
        protocol: RELOAD_SHELL_OWNER_PROTOCOL,
        hubNonce,
        beginActivation(identity, startReason, activationNonce) {
            requireNonce(activationNonce, 'activation nonce');
            const identityKey = reloadShellIdentityKey(identity);
            let slot = slots.get(identityKey);
            if (slot === undefined) {
                const claimNonce = nextNonce();
                requireNonce(claimNonce, 'claim nonce');
                slot = {
                    identity: Object.freeze({ ...identity }),
                    identityKey,
                    generation: 1,
                    handoffCount: 0,
                    phase: 'claiming',
                    activationNonce,
                    claimNonce,
                    executions: new Map(),
                    queuedChanged: new Set(),
                    queuedTerminal: new Set(),
                };
                const claim = Object.freeze({
                    protocol: RELOAD_SHELL_OWNER_PROTOCOL,
                    hubNonce,
                    claimNonce,
                    identity: slot.identity,
                    identityKey,
                    generation: 1,
                    activationNonce,
                    executions: Object.freeze([]),
                });
                slot.claim = claim;
                slots.set(identityKey, slot);
                return claim;
            }
            if (!sameIdentity(slot.identity, identity)) {
                throw ownerError('pi_bg_reload_owner_activation_conflict', 'another activation owns a non-identical reload shell identity under this key');
            }
            if (slot.phase !== 'handoff' || startReason !== 'reload') {
                throw ownerError('pi_bg_reload_owner_activation_conflict', `another package activation already owns session ${JSON.stringify(identity.sessionId)} in state ${slot.phase}`);
            }
            if (slot.expiresAt === undefined || now() >= slot.expiresAt) {
                return failStale('reload handoff expired before activation claim');
            }
            slot.phase = 'claiming';
            slot.generation += 1;
            slot.activationNonce = activationNonce;
            const claimNonce = nextNonce();
            requireNonce(claimNonce, 'claim nonce');
            slot.claimNonce = claimNonce;
            const claim = Object.freeze({
                protocol: RELOAD_SHELL_OWNER_PROTOCOL,
                hubNonce,
                claimNonce,
                identity: slot.identity,
                identityKey,
                generation: slot.generation,
                activationNonce,
                expiresAt: slot.expiresAt,
                executions: Object.freeze([...slot.executions.values()].filter((execution) => execution.admissionCommitted)),
            });
            slot.claim = claim;
            return claim;
        },
        commitActivation(claim, adapter) {
            const slot = slotForClaim(claim);
            if (adapter.activationNonce !== claim.activationNonce) {
                return failStale('host adapter activation nonce does not match its claim');
            }
            const lease = Object.freeze({
                protocol: RELOAD_SHELL_OWNER_PROTOCOL,
                hubNonce,
                identityKey: slot.identityKey,
                generation: slot.generation,
                activationNonce: slot.activationNonce,
            });
            try {
                adapter.onBound(lease);
            }
            catch (error) {
                slot.phase = slot.expiresAt === undefined ? 'releasing' : 'handoff';
                slot.claim = undefined;
                delete slot.claimNonce;
                if (slot.expiresAt === undefined || slot.executions.size === 0) {
                    clearHandoffTimer(slot);
                    slots.delete(slot.identityKey);
                }
                else {
                    armHandoffDeadline(slot);
                }
                throw error;
            }
            slot.lease = lease;
            slot.claim = undefined;
            delete slot.claimNonce;
            slot.phase = 'bound';
            slot.adapter = adapter;
            clearHandoffTimer(slot);
            delete slot.expiresAt;
            for (const execution of claim.executions) {
                execution.updateLeaseAudit(slot.generation, slot.handoffCount);
                slot.queuedChanged.add(execution.launchNonce);
                if (execution.phase === 'terminal')
                    slot.queuedTerminal.add(execution.launchNonce);
            }
            for (const nonce of [...slot.queuedChanged]) {
                const execution = slot.executions.get(nonce);
                if (execution === undefined)
                    continue;
                slot.queuedChanged.delete(nonce);
                dispatch(slot, 'changed', execution);
            }
            for (const nonce of [...slot.queuedTerminal]) {
                const execution = slot.executions.get(nonce);
                if (execution === undefined)
                    continue;
                slot.queuedTerminal.delete(nonce);
                dispatch(slot, 'terminal', execution);
            }
            return lease;
        },
        abortActivation(claim, error) {
            void error;
            const slot = slotForClaim(claim);
            slot.claim = undefined;
            delete slot.claimNonce;
            if (slot.expiresAt === undefined) {
                slot.phase = 'releasing';
                if (slot.executions.size === 0)
                    slots.delete(slot.identityKey);
                return;
            }
            slot.phase = 'handoff';
            if (slot.executions.size === 0) {
                clearHandoffTimer(slot);
                slots.delete(slot.identityKey);
                return;
            }
            armHandoffDeadline(slot);
        },
        beginReloadHandoff(lease) {
            const slot = currentSlotForLease(lease);
            // Detach first: no child/timer callback after this line can reach an old
            // registry or Pi closure.
            slot.adapter = undefined;
            slot.phase = 'handoff';
            slot.handoffCount += 1;
            slot.expiresAt = now() + handoffTimeoutMs;
            slot.lease = undefined;
            const transferred = [];
            for (const execution of [...slot.executions.values()]) {
                if (execution.admissionCommitted) {
                    slot.queuedChanged.add(execution.launchNonce);
                    if (execution.phase === 'terminal')
                        slot.queuedTerminal.add(execution.launchNonce);
                    transferred.push(execution);
                    continue;
                }
                // Admission closure remains old-registry owned and uncommitted work is
                // never claimable. Keep its process authority in the hub until terminal
                // settlement, without requiring either the old or fresh host adapter.
                void releaseAfterTerminal(slot, execution);
            }
            if (slot.executions.size === 0) {
                clearHandoffTimer(slot);
                slots.delete(slot.identityKey);
                return Object.freeze([]);
            }
            armHandoffDeadline(slot);
            return Object.freeze(transferred);
        },
        releaseActivation(lease) {
            const slot = currentSlotForLease(lease);
            slot.adapter = undefined;
            slot.lease = undefined;
            slot.phase = 'releasing';
            clearHandoffTimer(slot);
            for (const execution of [...slot.executions.values()]) {
                if (execution.phase === 'terminal')
                    removeExecution(slot, execution);
            }
            if (slot.executions.size === 0)
                slots.delete(slot.identityKey);
        },
        registerExecution(lease, execution) {
            const slot = currentSlotForLease(lease);
            if (execution.protocol !== RELOAD_SHELL_OWNER_PROTOCOL) {
                throw ownerError('pi_bg_reload_owner_protocol_incompatible', 'reload shell execution protocol is incompatible');
            }
            if (slot.executions.has(execution.launchNonce)) {
                throw ownerError('pi_bg_reload_owner_activation_conflict', `reload shell launch nonce ${execution.launchNonce} is already registered`);
            }
            slot.executions.set(execution.launchNonce, execution);
            execution.setOwnerEventSink({
                onChanged: (changed) => dispatch(slot, 'changed', changed),
                onTerminal: (terminal) => dispatch(slot, 'terminal', terminal),
            });
        },
        markAdmissionCommitted(lease, execution) {
            const slot = currentSlotForLease(lease);
            if (slot.executions.get(execution.launchNonce) !== execution) {
                return failStale('cannot commit an execution not registered to this activation');
            }
            execution.markAdmissionCommitted(slot.generation, slot.handoffCount);
        },
        releaseExecution(leaseOrClaim, execution) {
            let slot;
            if ('claimNonce' in leaseOrClaim)
                slot = slotForClaim(leaseOrClaim);
            else
                slot = currentSlotForLease(leaseOrClaim);
            if (slot.executions.get(execution.launchNonce) !== execution) {
                return failStale('cannot release an execution not owned by this activation');
            }
            if (execution.phase === 'terminal') {
                removeExecution(slot, execution);
                return;
            }
            // A bounded stop wait is not terminal proof. Retain the child, streams,
            // listeners, tree state, and timers under this slot until the execution's
            // one terminal continuation can release them safely.
            void releaseAfterTerminal(slot, execution);
        },
        isCurrentLease(lease) {
            try {
                currentSlotForLease(lease);
                return true;
            }
            catch {
                return false;
            }
        },
    });
    const internalState = { slots };
    hubStates.set(hub, internalState);
    Object.defineProperty(hub, OWNER_STATE_SYMBOL, {
        value: internalState,
        enumerable: false,
        configurable: false,
        writable: false,
    });
    return hub;
}
export function getProcessReloadShellOwnerV1() {
    const current = Reflect.get(globalThis, RELOAD_SHELL_OWNER_SYMBOL);
    if (current !== undefined) {
        if (!structuralHub(current)) {
            throw ownerError('pi_bg_reload_owner_protocol_incompatible', `global symbol ${RELOAD_SHELL_OWNER_PROTOCOL} contains an incompatible value`);
        }
        return current;
    }
    const created = createReloadShellOwnerHubForTests();
    Reflect.set(globalThis, RELOAD_SHELL_OWNER_SYMBOL, created);
    return created;
}
/** Direct-source-only deterministic inspection seam; not exported by a package facade. */
export function inspectReloadShellOwnerForTests(hub, identity) {
    const localState = hubStates.get(hub);
    const reflectedState = Reflect.get(hub, OWNER_STATE_SYMBOL);
    const state = localState ??
        (typeof reflectedState === 'object' && reflectedState !== null
            ? reflectedState
            : undefined);
    if (state === undefined) {
        return {
            phase: undefined,
            generation: undefined,
            expiresAt: undefined,
            hasAdapter: false,
            executions: Object.freeze([]),
        };
    }
    const slot = state.slots.get(reloadShellIdentityKey(identity));
    return {
        phase: slot?.phase,
        generation: slot?.generation,
        expiresAt: slot?.expiresAt,
        hasAdapter: slot?.adapter !== undefined,
        executions: Object.freeze(slot === undefined ? [] : [...slot.executions.values()]),
    };
}
async function writeOwnerMetadata(path, value, signal) {
    await replaceFileDurable(path, `${JSON.stringify(value, null, 2)}\n`, signal === undefined ? {} : { signal });
}
async function closeOwnerOutputStream(stream) {
    if (stream === undefined || stream.destroyed || stream.closed)
        return;
    await new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            stream.off('error', fail);
            stream.off('close', finish);
            stream.off('finish', finish);
            resolve();
        };
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            stream.off('close', finish);
            stream.off('finish', finish);
            reject(error);
        };
        stream.once('close', finish);
        stream.once('finish', finish);
        stream.once('error', fail);
        stream.end();
    });
}
function taskkillDescription(outcome) {
    return [
        `exit=${String(outcome.exitCode)}`,
        `signal=${String(outcome.signal)}`,
        outcome.stdout.length > 0 ? `stdout=${JSON.stringify(outcome.stdout)}` : '',
        outcome.stderr.length > 0 ? `stderr=${JSON.stringify(outcome.stderr)}` : '',
        outcome.stdoutTruncated ? 'stdout_truncated=true' : '',
        outcome.stderrTruncated ? 'stderr_truncated=true' : '',
    ]
        .filter(Boolean)
        .join(' ');
}
/**
 * Create and spawn the complete live execution retained by the process-global
 * owner. The returned object is structural and survives hot-loaded module copies.
 */
export function createReloadableShellExecutionV1(options) {
    const task = options.task;
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const now = options.now ?? Date.now;
    const logger = options.logger ?? console;
    const spawn = options.spawn ??
        ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
    const killProcess = options.killProcess ?? process.kill.bind(process);
    const killTree = options.killTree ??
        ((pid, phase, signal) => {
            const taskkillOptions = signal === undefined ? { env } : { env, signal };
            return runWindowsTaskkill(pid, phase, taskkillOptions);
        });
    const collectPosixDescendantPids = options.collectPosixDescendantPids ??
        ((rootPid) => collectPosixDescendantPidsDefault(rootPid));
    const outputStream = createWriteStream(task.outputAbsPath, { flags: 'a', encoding: 'utf8' });
    let child;
    try {
        child = spawn(options.invocation.shell, [...options.invocation.args], {
            cwd: task.cwd,
            detached: platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
            env,
            windowsHide: true,
            windowsVerbatimArguments: options.invocation.windowsVerbatimArguments,
        });
    }
    catch (error) {
        outputStream.destroy();
        throw error;
    }
    const childPid = child.pid;
    if (childPid === undefined || !Number.isSafeInteger(childPid) || childPid <= 0) {
        outputStream.destroy();
        try {
            child.kill('SIGKILL');
        }
        catch {
            // The loud launch error remains authoritative; no PID authority was acquired.
        }
        throw ownerError('pi_bg_reload_owner_unavailable', 'opted reload shell spawn did not provide a positive child pid');
    }
    task.child = child;
    task.pid = childPid;
    task.stream = outputStream;
    if (platform !== 'win32')
        task.ownedPosixProcessGroupId = childPid;
    const spawnedAt = task.startTime;
    const timeoutDeadlineAt = task.timeoutSeconds === undefined ? undefined : spawnedAt + task.timeoutSeconds * 1000;
    const audit = {
        schemaVersion: 'pi-background-tasks.reload-shell.v1',
        authority: 'same-process-live-owner',
        hostPid: options.identity.hostPid,
        sessionId: options.identity.sessionId,
        cwdRealpath: options.identity.cwdRealpath,
        launchNonce: options.launchNonce,
        completionId: `${task.id}:1`,
        spawnedAt,
        childPid,
        outputCapBytes: options.maxOutputBytes,
        leaseGeneration: options.lease.generation,
        handoffCount: 0,
    };
    if (timeoutDeadlineAt !== undefined)
        audit.timeoutDeadlineAt = timeoutDeadlineAt;
    if (platform === 'win32')
        audit.windowsTreeRootPid = childPid;
    else
        audit.posixProcessGroupId = childPid;
    task.reloadSurvival = audit;
    let sink;
    let resolveTerminal = () => { };
    const terminal = new Promise((resolve) => {
        resolveTerminal = resolve;
    });
    let resolveInitialMetadata = () => { };
    let rejectInitialMetadata = () => { };
    let initialMetadataSettled = false;
    const initialMetadata = new Promise((resolve, reject) => {
        resolveInitialMetadata = resolve;
        rejectInitialMetadata = reject;
    });
    void initialMetadata.catch(() => undefined);
    let finalization;
    let posixTree;
    let windowsTree;
    let stopKind;
    let notificationToken;
    const writeMetadata = async (value = snapshot(task), signal) => {
        const write = async () => {
            await writeOwnerMetadata(task.metadataAbsPath, value, signal);
        };
        const previous = task.metadataWriteChain ?? Promise.resolve();
        const next = previous.then(write, write);
        task.metadataWriteChain = next.catch(() => undefined);
        await next;
    };
    const changed = () => {
        sink?.onChanged(execution);
    };
    const writeBuffer = (buffer) => {
        const capExceeded = writeTaskOutputChunk(task, buffer, {
            softBytes: options.softOutputBytes,
            hardBytes: execution.outputCapBytes,
            onSoftCapWarned: changed,
        });
        if (!capExceeded)
            return;
        task.failedReason = 'output_limit';
        changed();
        void execution
            .requestStop('output_cap', task.error)
            .catch((error) => {
            task.error = appendErrorText(task.error, `kill failed: ${boundedErrorMessage(error, 500)}`);
        });
    };
    const ingestTelemetry = (text) => {
        if (text.length === 0)
            return;
        // 归一化解析收敛到共享 parseTelemetryStream(registry/reload 两套近逐行重复)
        const parsed = parseTelemetryStream(text, task.contextUsageBuffer ?? '');
        task.contextUsageBuffer = parsed.retained;
        const before = JSON.stringify({
            contextUsage: task.contextUsage,
            tokenUsage: task.tokenUsage,
            toolUsage: task.toolUsage,
            model: task.model,
        });
        if (parsed.latest.context !== undefined)
            task.contextUsage = parsed.latest.context;
        if (parsed.latest.tokens !== undefined)
            task.tokenUsage = parsed.latest.tokens;
        if (parsed.latest.tools !== undefined)
            task.toolUsage = parsed.latest.tools;
        if (parsed.latest.model !== undefined)
            task.model = parsed.latest.model;
        const after = JSON.stringify({
            contextUsage: task.contextUsage,
            tokenUsage: task.tokenUsage,
            toolUsage: task.toolUsage,
            model: task.model,
        });
        if (before !== after) {
            changed();
            void writeMetadata().catch((error) => {
                logger.error(`[background-tasks] failed to write survivor telemetry for ${task.id}:`, error);
            });
        }
    };
    const finishPosix = (state, failure) => {
        if (state.settled)
            return;
        state.settled = true;
        state.failure = failure;
        if (state.verificationTimer !== undefined)
            clearTimeout(state.verificationTimer);
        clearPosixDescendantCollectTimer(state);
        if (task.killEscalationTimer !== undefined)
            clearTimeout(task.killEscalationTimer);
        delete task.killEscalationTimer;
        task.posixProcessGroupSignalAuthorityReleased = true;
        if (failure === undefined && task.ownedPosixProcessGroupId === state.groupId) {
            delete task.ownedPosixProcessGroupId;
        }
        state.resolve();
    };
    const probePosixGone = (state) => {
        if (state.settled)
            return state.failure === undefined;
        try {
            const present = killProcess(-state.groupId, 0);
            state.lastProbeError = present
                ? undefined
                : new Error(`process-group probe for ${String(state.groupId)} returned false`);
            return false;
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH') {
                finishPosix(state);
                return true;
            }
            state.lastProbeError =
                error instanceof Error ? error : new Error(errorMessage(error));
            return false;
        }
    };
    const recordPosixFailure = (state, error) => {
        task.error = appendErrorText(task.error, error.message);
        writeBuffer(Buffer.from(`\n[background task POSIX termination: ${error.message}]\n`, 'utf8'));
        finishPosix(state, error);
        changed();
    };
    const verifyPosix = (state) => {
        if (state.settled)
            return;
        const remaining = state.deadlineAt - now();
        if (remaining <= 0) {
            const detail = state.lastProbeError ? `; last group probe failed: ${state.lastProbeError.message}` : '';
            recordPosixFailure(state, new Error(`POSIX process group ${String(state.groupId)} remained present after SIGKILL${detail}. Descendant processes may have leaked.`));
            return;
        }
        state.verificationTimer = setTimeout(() => {
            state.verificationTimer = undefined;
            if (!probePosixGone(state))
                verifyPosix(state);
        }, Math.min(10, remaining));
    };
    const forcePosix = (state) => {
        if (state.settled || state.forceAttempted)
            return;
        state.forceAttempted = true;
        if (task.killEscalationTimer !== undefined)
            clearTimeout(task.killEscalationTimer);
        delete task.killEscalationTimer;
        clearPosixDescendantCollectTimer(state);
        if (probePosixGone(state))
            return;
        try {
            if (!killProcess(-state.groupId, 'SIGKILL')) {
                recordPosixFailure(state, new Error(`POSIX process-group SIGKILL returned false for task ${task.id} group ${String(state.groupId)}. Descendant processes may have leaked.`));
                return;
            }
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH') {
                finishPosix(state);
                return;
            }
            recordPosixFailure(state, new Error(`POSIX process-group SIGKILL failed for task ${task.id} group ${String(state.groupId)}: ${boundedErrorMessage(error, 500)}. Descendant processes may have leaked.`));
            return;
        }
        // M3 REVIEW:组信号后对窗口内收集到的后代逐个补杀(与普通路径一致):ESRCH
        // 属自然死亡/组信号回收,非 ESRCH 失败仅追加 notice/error,不替代组存在的
        // 证明性结论(组证明仍是权威终止证明)。
        const descendantFailures = forceKillCollectedDescendants(state);
        if (descendantFailures.length > 0) {
            const message = `POSIX descendant SIGKILL failed for task ${task.id} group ${String(state.groupId)}: ` +
                `${descendantFailures.join('; ')}. Descendant processes may have leaked.`;
            task.error = appendErrorText(task.error, message);
            writeBuffer(Buffer.from(`\n[background task POSIX termination: ${message}]\n`, 'utf8'));
            changed();
        }
        if (!probePosixGone(state))
            verifyPosix(state);
    };
    const beginPosixStop = () => {
        if (posixTree !== undefined)
            return posixTree;
        if (task.posixProcessGroupSignalAuthorityReleased === true) {
            throw new Error(`Task ${task.id} has released its POSIX process-group signal authority`);
        }
        const groupId = task.ownedPosixProcessGroupId;
        if (groupId === undefined)
            throw new Error(`Task ${task.id} has no owned POSIX process group`);
        let resolve = () => { };
        const completion = new Promise((resolvePromise) => {
            resolve = resolvePromise;
        });
        const reserve = Math.min(25, Math.max(1, Math.floor(options.stopWaitMs / 4)));
        const ownershipMs = Math.max(1, options.stopWaitMs - reserve);
        const state = {
            groupId,
            deadlineAt: now() + ownershipMs,
            completion,
            resolve,
            forceAttempted: false,
            settled: false,
        };
        posixTree = state;
        task.killEscalationTimer = setTimeout(() => {
            delete task.killEscalationTimer;
            forcePosix(state);
        }, Math.min(options.killGraceMs, ownershipMs));
        // M3 REVIEW:同在 grace 窗口内安排一次 ps 后代收集(与普通路径一致),供
        // force 阶段对逃逸出组的孙进程逐个补杀;失败退化到组信号路径。
        schedulePosixDescendantCollection(state, ownershipMs);
        return state;
    };
    /** M3 REVIEW:在 grace 窗口内(生产为 TERM 后 1500ms)安排一次 ps 后代收集。 */
    const schedulePosixDescendantCollection = (state, ownershipMs) => {
        if (state.settled || state.forceAttempted)
            return;
        const delayMs = Math.min(POSIX_DESCENDANT_COLLECT_DELAY_MS, Math.floor(options.killGraceMs / 2), ownershipMs);
        state.descendantCollectTimer = setTimeout(() => {
            state.descendantCollectTimer = undefined;
            if (state.settled || state.forceAttempted)
                return;
            void collectPosixDescendantPids(state.groupId)
                .then((pids) => {
                if (state.settled || state.forceAttempted)
                    return;
                state.descendantPids = pids;
            })
                .catch(() => {
                // 收集失败不改变终止流程,退化到组信号路径。
            });
        }, delayMs).unref();
    };
    const clearPosixDescendantCollectTimer = (state) => {
        if (state.descendantCollectTimer !== undefined) {
            clearTimeout(state.descendantCollectTimer);
            state.descendantCollectTimer = undefined;
        }
    };
    /**
     * 对收集到的后代逐个 SIGKILL;返回非 ESRCH 失败明细。ESRCH(后代已自然退出
     * 或已被组信号回收)属正常路径,不加失败。
     */
    const forceKillCollectedDescendants = (state) => {
        const descendants = state.descendantPids;
        if (descendants === undefined || descendants.size === 0)
            return [];
        const failures = [];
        for (const pid of descendants) {
            try {
                const forced = killProcess(pid, 'SIGKILL');
                if (!forced)
                    failures.push(`pid ${String(pid)} SIGKILL returned false`);
            }
            catch (error) {
                if (typeof error === 'object' &&
                    error !== null &&
                    Reflect.get(error, 'code') === 'ESRCH')
                    continue;
                failures.push(`pid ${String(pid)} ${boundedErrorMessage(error, 500)}`);
            }
        }
        return failures;
    };
    const requestPosixStop = () => {
        const state = beginPosixStop();
        if (task.killSignalSent)
            return;
        task.killSignalSent = true;
        const failures = [];
        let sent = false;
        try {
            sent = killProcess(-state.groupId, 'SIGTERM');
            if (!sent)
                failures.push('process-group SIGTERM returned false');
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH') {
                finishPosix(state);
            }
            else {
                failures.push(`process-group SIGTERM failed: ${boundedErrorMessage(error, 500)}`);
            }
        }
        if (!sent && !state.settled) {
            try {
                sent = execution.child?.kill('SIGTERM') === true;
                if (!sent)
                    failures.push('child SIGTERM returned false');
            }
            catch (error) {
                failures.push(`child SIGTERM failed: ${boundedErrorMessage(error, 500)}`);
            }
        }
        if (!sent && !state.settled) {
            forcePosix(state);
            throw new Error(`Could not kill task ${task.id}: ${failures.join('; ')}`);
        }
    };
    const finishWindows = (state, failure) => {
        if (state.settled)
            return;
        state.settled = true;
        state.failure = failure;
        if (task.killEscalationTimer !== undefined)
            clearTimeout(task.killEscalationTimer);
        delete task.killEscalationTimer;
        state.resolve();
    };
    const evaluateTaskkill = (state, phase, outcome) => {
        if (outcome.exitCode === 0 || outcome.exitCode === 128)
            return undefined;
        if (phase === 'terminate')
            return undefined;
        return new Error(`Windows taskkill /T /F force termination failed for task ${task.id} pid ${String(state.pid)}: ${taskkillDescription(outcome)}. Descendant processes may have leaked.`);
    };
    const forceWindows = (state) => {
        if (state.forcePromise !== undefined)
            return state.forcePromise;
        state.forceAttempted = true;
        state.softController?.abort();
        if (task.killEscalationTimer !== undefined)
            clearTimeout(task.killEscalationTimer);
        delete task.killEscalationTimer;
        const launched = Promise.resolve().then(() => killTree(state.pid, 'force'));
        state.forcePromise = launched.then((outcome) => {
            const failure = evaluateTaskkill(state, 'force', outcome);
            if (failure !== undefined) {
                task.error = appendErrorText(task.error, failure.message);
                finishWindows(state, failure);
                throw failure;
            }
            finishWindows(state);
        }, (error) => {
            const failure = new Error(`Windows taskkill /T /F force termination failed for task ${task.id} pid ${String(state.pid)}: ${boundedErrorMessage(error, 500)}. Descendant processes may have leaked.`);
            task.error = appendErrorText(task.error, failure.message);
            finishWindows(state, failure);
            throw failure;
        });
        void state.forcePromise.catch((error) => {
            logger.error(`[background-tasks] Windows survivor force kill failed for ${task.id}:`, error);
        });
        return state.forcePromise;
    };
    const beginWindowsStop = () => {
        if (windowsTree !== undefined)
            return windowsTree;
        let resolve = () => { };
        const completion = new Promise((resolvePromise) => {
            resolve = resolvePromise;
        });
        const state = {
            pid: childPid,
            completion,
            resolve,
            forceAttempted: false,
            settled: false,
        };
        windowsTree = state;
        const controller = new AbortController();
        state.softController = controller;
        state.softPromise = Promise.resolve()
            .then(() => killTree(childPid, 'terminate', controller.signal))
            .then((outcome) => {
            if (state.forceAttempted || state.settled)
                return;
            if (outcome.exitCode === 0 || outcome.exitCode === 128)
                finishWindows(state);
            // Other soft failures deliberately retain force escalation.
        }, () => {
            // Soft failure deliberately retains force escalation.
        });
        task.killEscalationTimer = setTimeout(() => {
            delete task.killEscalationTimer;
            void forceWindows(state);
        }, options.killGraceMs);
        return state;
    };
    const requestWindowsStop = () => {
        beginWindowsStop();
        task.killSignalSent = true;
    };
    const awaitTreeBeforeTerminal = async () => {
        if (platform === 'win32') {
            if (windowsTree === undefined)
                return undefined;
            await windowsTree.completion;
            return windowsTree.failure;
        }
        if (posixTree === undefined) {
            task.posixProcessGroupSignalAuthorityReleased = true;
            delete task.ownedPosixProcessGroupId;
            return undefined;
        }
        probePosixGone(posixTree);
        await posixTree.completion;
        return posixTree.failure;
    };
    const terminalStatus = (code, signal) => {
        // M2 状态迁移表(六态迁移表共享判定):user/model 停止 → cancelled;system 关闭 →
        // killed;timeout / output_limit / disk_full / handoff_expired / 退出码非 0 → failed
        return deriveTerminalStatus(task, stopKind, code, signal, execution.outputCapBytes);
    };
    const finalize = (code, signal) => {
        if (finalization !== undefined)
            return;
        execution.closeObservation = { code, signal, observedAt: now() };
        execution.phase = 'finalizing';
        finalization = (async () => {
            let result = terminalStatus(code, signal);
            try {
                await initialMetadata;
            }
            catch (error) {
                result = {
                    status: 'failed',
                    error: appendErrorText(result.error, `Initial metadata write failed: ${boundedErrorMessage(error, 500)}`),
                };
            }
            const treeFailure = await awaitTreeBeforeTerminal();
            if (treeFailure !== undefined) {
                result = { status: 'failed', error: appendErrorText(result.error, treeFailure.message) };
            }
            try {
                await closeOwnerOutputStream(execution.outputStream);
            }
            catch (error) {
                result = {
                    status: 'failed',
                    error: appendErrorText(result.error, `Final output durability failed: ${boundedErrorMessage(error, 500)}`),
                };
            }
            task.exitCode = code;
            task.signal = signal;
            task.endTime = now();
            if (result.error !== undefined)
                task.error = result.error;
            try {
                await writeMetadata({ ...snapshot(task), status: result.status });
                task.status = result.status;
            }
            catch (error) {
                task.status = 'failed';
                task.error = `Terminal metadata write failed: ${boundedErrorMessage(error, 500)}`;
                logger.error(`[background-tasks] failed to write survivor metadata for ${task.id}:`, error);
                await writeMetadata().catch(() => undefined);
            }
            task.finalized = true;
            if (task.timeoutHandle !== undefined)
                clearTimeout(task.timeoutHandle);
            delete task.timeoutHandle;
            for (const waiter of task.waiters.splice(0))
                waiter();
            execution.phase = 'terminal';
            resolveTerminal(task);
            changed();
            sink?.onTerminal(execution);
        })().catch((error) => {
            logger.error(`[background-tasks] reload shell finalization failed for ${task.id}:`, error);
        });
    };
    let stdoutListener = () => { };
    let stderrListener = () => { };
    let childErrorListener = () => { };
    let childCloseListener = () => { };
    let streamErrorListener = () => { };
    const execution = {
        protocol: RELOAD_SHELL_OWNER_PROTOCOL,
        launchNonce: options.launchNonce,
        completionId: `${task.id}:1`,
        task,
        child,
        outputStream,
        spawnedAt,
        timeoutDeadlineAt,
        outputCapBytes: options.maxOutputBytes,
        terminal,
        phase: 'starting',
        admissionCommitted: false,
        notificationState: task.notifyOnCompletion ? 'pending' : 'disabled',
        async requestStop(kind, reason) {
            if (execution.phase === 'released')
                return task;
            if (execution.phase === 'terminal')
                return task;
            const firstStop = stopKind === undefined;
            if (firstStop) {
                stopKind = kind;
                task.killKind = kind === 'handoff_expired' ? 'shutdown' : kind;
                if (reason !== undefined)
                    task.error = reason;
            }
            if (firstStop && kind === 'handoff_expired' && !task.error?.startsWith('pi_bg_reload_handoff_expired')) {
                task.error = `pi_bg_reload_handoff_expired: ${task.error ?? 'reload handoff expired'}`;
            }
            if (execution.phase === 'finalizing')
                return terminal;
            if (execution.phase === 'running' || execution.phase === 'starting') {
                execution.phase = 'stop_requested';
            }
            if (task.status === 'running') {
                if (platform === 'win32')
                    requestWindowsStop();
                else
                    requestPosixStop();
            }
            let timeout;
            try {
                return await Promise.race([
                    terminal,
                    new Promise((_resolve, reject) => {
                        timeout = setTimeout(() => reject(new Error(`Task ${task.id} did not exit within ${String(options.stopWaitMs)}ms after cancellation`)), options.stopWaitMs);
                    }),
                ]);
            }
            finally {
                if (timeout !== undefined)
                    clearTimeout(timeout);
            }
        },
        async commitInitialMetadata(signal) {
            try {
                await writeMetadata(snapshot(task), signal);
                if (!initialMetadataSettled) {
                    initialMetadataSettled = true;
                    resolveInitialMetadata();
                }
            }
            catch (error) {
                if (!initialMetadataSettled) {
                    initialMetadataSettled = true;
                    rejectInitialMetadata(error);
                }
                throw error;
            }
        },
        failAdmission(error) {
            if (!initialMetadataSettled) {
                initialMetadataSettled = true;
                rejectInitialMetadata(error);
            }
        },
        setOwnerEventSink(next) {
            sink = next;
        },
        markAdmissionCommitted(generation, handoffCount) {
            execution.admissionCommitted = true;
            execution.phase = execution.phase === 'starting' ? 'running' : execution.phase;
            audit.leaseGeneration = generation;
            audit.handoffCount = handoffCount;
        },
        updateLeaseAudit(generation, handoffCount) {
            audit.leaseGeneration = generation;
            audit.handoffCount = handoffCount;
        },
        abandonReloadHandoff() {
            if (task.terminalPublicationState === 'pending') {
                task.terminalPublicationState = 'abandoned';
                task.terminalPublicationAbandonReason = 'reload_handoff_expired';
                task.terminalPublished = false;
            }
            if (task.status === 'running') {
                task.error = appendErrorText(task.error, 'pi_bg_reload_handoff_expired: no compatible reload activation claimed this execution');
            }
            void writeMetadata().catch((error) => {
                logger.error(`[background-tasks] failed to persist handoff expiry for ${task.id}:`, error);
            });
        },
        beginNotification(lease) {
            if (execution.notificationState !== 'pending')
                return undefined;
            const token = `${String(lease.generation)}:${lease.activationNonce}:${randomNonce()}`;
            notificationToken = token;
            execution.notificationState = 'sending';
            return token;
        },
        finishNotification(token, delivered) {
            if (notificationToken !== token || execution.notificationState !== 'sending')
                return;
            notificationToken = undefined;
            if (delivered) {
                execution.notificationState = 'delivered';
                task.notified = true;
            }
            else {
                execution.notificationState = 'pending';
                task.notified = false;
            }
        },
        releaseResources() {
            if (task.timeoutHandle !== undefined)
                clearTimeout(task.timeoutHandle);
            if (task.killEscalationTimer !== undefined)
                clearTimeout(task.killEscalationTimer);
            if (posixTree?.verificationTimer !== undefined)
                clearTimeout(posixTree.verificationTimer);
            if (posixTree !== undefined)
                clearPosixDescendantCollectTimer(posixTree);
            windowsTree?.softController?.abort();
            execution.child?.stdout?.off?.('data', stdoutListener);
            execution.child?.stderr?.off?.('data', stderrListener);
            execution.child?.off?.('error', childErrorListener);
            execution.child?.off?.('close', childCloseListener);
            execution.outputStream?.off('error', streamErrorListener);
            sink = undefined;
            execution.child = undefined;
            execution.outputStream = undefined;
            delete task.child;
            delete task.stream;
            delete task.timeoutHandle;
            delete task.killEscalationTimer;
            delete task.reloadExecution;
            execution.phase = 'released';
        },
    };
    task.reloadExecution = execution;
    streamErrorListener = (error) => {
        task.error = `Output file write failed: ${error.message}`;
        changed();
        if (task.status === 'running') {
            const diskFull = isEnospcError(error);
            if (diskFull)
                task.failedReason = 'disk_full';
            void execution
                .requestStop(diskFull ? 'disk_full' : 'output_cap', task.error)
                .catch((stopError) => {
                logger.error(`[background-tasks] failed to stop survivor after stream error ${task.id}:`, stopError);
            });
        }
    };
    stdoutListener = (data) => {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        ingestTelemetry(buffer.toString('utf8'));
        writeBuffer(buffer);
    };
    stderrListener = (data) => {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        ingestTelemetry(buffer.toString('utf8'));
        writeBuffer(buffer);
    };
    childErrorListener = (error) => {
        task.error = appendErrorText(task.error, `Background task spawn error: ${error.message}`);
        writeBuffer(Buffer.from(`\n[background task spawn error: ${error.message}]\n`, 'utf8'));
        changed();
    };
    childCloseListener = (code, signal) => {
        if (execution.closeObservation !== undefined)
            return;
        finalize(code, signal);
    };
    outputStream.on('error', streamErrorListener);
    child.stdout?.on('data', stdoutListener);
    child.stderr?.on('data', stderrListener);
    child.on('error', childErrorListener);
    child.on('close', childCloseListener);
    if (timeoutDeadlineAt !== undefined) {
        task.timeoutHandle = setTimeout(() => {
            if (task.status !== 'running' || execution.phase === 'terminal' || execution.phase === 'released')
                return;
            const message = `Timed out after ${String(task.timeoutSeconds)}s`;
            writeBuffer(Buffer.from(`\n[background task timeout: ${message}]\n`, 'utf8'));
            void execution.requestStop('timeout', message).catch((error) => {
                logger.error(`[background-tasks] survivor timeout stop failed for ${task.id}:`, error);
            });
        }, Math.max(0, timeoutDeadlineAt - now()));
    }
    return execution;
}
//# sourceMappingURL=reload-shell-owner.js.map