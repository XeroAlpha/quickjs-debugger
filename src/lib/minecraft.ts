import type EventEmitter from 'node:events';
import type { DebugConnection, DebuggeeEvent } from './connection.js';
import {
    type BreakpointInfo,
    type BreakpointStatus,
    QuickJSDebugSession,
    type QuickJSDebugSessionEvents,
} from './session.js';

export enum ProtocolVersion {
    Unknown = 0,
    /**
     * Initial version
     */
    Initial = 1,
    /**
     * Add targetModuleUuid to protocol event
     * @since Minecraft 1.21.10
     */
    SupportTargetModuleUuid = 2,
    /**
     * Add array of plugins and target module ids to incoming protocol event
     * @since Minecraft 1.21.40
     */
    SupportTargetSelection = 3,
    /**
     * MC can require a passcode to connect
     * @since Minecraft 1.21.50
     */
    SupportPasscode = 4,
    /**
     * Debugger can take MC script profiler captures
     * @since Minecraft 1.21.50.25
     */
    SupportProfilerCaptures = 5,
    /**
     * Breakpoints as request, MC can reject
     * @since Minecraft 1.21.130.24
     */
    SupportBreakpointsAsRequest = 6,
}

export interface ProtocolInfo {
    version: number;
    targetModuleUuid?: string;
    passcode?: string;
}

export enum LogLevel {
    Verbose = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
    Fatal = 4,
}

export interface LogEvent extends DebuggeeEvent {
    type: 'PrintEvent';
    message: string;
    logLevel: LogLevel;
}

export interface ProtocolEvent extends DebuggeeEvent {
    type: 'ProtocolEvent';
    version: number;
}

export interface ProtocolEventV3 extends ProtocolEvent {
    plugins: {
        name: string;
        module_uuid: string;
    }[];
}

export interface ProtocolEventV4 extends ProtocolEventV3 {
    require_passcode?: boolean;
}

export interface ProfilerCaptureEvent {
    type: string;
    capture_base_path: string;
    capture_data: string;
}

export interface StatDataV1 {
    id: string;
    parent_id?: string;
    type?: string;
    label?: string;
    value?: string | number;
}

export interface StatDataModel {
    name: string;
    should_aggregate?: boolean;
    children?: StatDataModel[];
    values?: number[];
}

export interface StatMessageV1Event extends DebuggeeEvent {
    type: 'StatEvent';
    stats: StatDataV1[];
}

export interface StatMessageV2Event extends DebuggeeEvent {
    type: 'StatEvent2';
    tick: number;
    stats: StatDataModel[];
}

export interface StatTreeNode {
    name: string;
    label?: string;
    type?: string;
    updateTick?: number;
    aggregated?: boolean;
    values?: (string | number)[];
    children?: StatTree;
}

export type StatTree = Record<string, StatTreeNode | undefined>;

export interface StatEvent {
    stat: StatTree;
    tick: number;
}

function mergeStatTreeNodeV1(target: StatTree, updated: StatDataV1[], pathCache: Map<string, string[]>) {
    for (const statData of updated) {
        const path: string[] = [];
        if (statData.parent_id) {
            const cachedPath = pathCache.get(statData.parent_id);
            if (cachedPath) {
                path.push(...cachedPath);
            } else {
                continue;
            }
        }
        let currentTarget = target;
        for (const part of path) {
            const newTargetOwner = currentTarget[part];
            if (!newTargetOwner) {
                throw new Error(`Cannot find node in stat tree: ${path.join('->')}`);
            }
            if (!newTargetOwner.children) {
                newTargetOwner.children = {};
            }
            currentTarget = newTargetOwner.children;
        }
        if (!pathCache.has(statData.id)) {
            pathCache.set(statData.id, [...path, statData.id]);
        }
        let existed = currentTarget[statData.id];
        if (!existed) {
            existed = currentTarget[statData.id] = { name: statData.id };
        }
        existed.label = statData.label;
        existed.type = statData.type;
        if (statData.value !== undefined) {
            existed.values = [statData.value];
        }
    }
    return target;
}

function mergeStatTreeNodeV2(target: StatTree, updated: StatDataModel[], tick: number) {
    for (const statData of updated) {
        let existed = target[statData.name];
        if (!existed) {
            existed = target[statData.name] = { name: statData.name };
        }
        existed.updateTick = tick;
        if (statData.values !== undefined) {
            existed.values = statData.values;
        }
        if (statData.values !== undefined) {
            existed.aggregated = statData.should_aggregate;
        }
        if (statData.children) {
            let children = existed.children;
            if (!children) {
                children = existed.children = {};
            }
            if (statData.should_aggregate === true) {
                const newKeys = new Set(statData.children.map((e) => e.name));
                const removingKeys = Object.keys(children).filter((e) => !newKeys.has(e));
                for (const key of removingKeys) {
                    delete children[key];
                }
            }
            mergeStatTreeNodeV2(children, statData.children, tick);
        }
    }
    return target;
}

export interface MinecraftDebugSessionEvents extends QuickJSDebugSessionEvents {
    log: [event: LogEvent];
    protocol: [event: ProtocolEvent];
    stat: [event: StatEvent];
    profilerCapture: [event: ProfilerCaptureEvent];
}

type ExtendEventMap<C extends { new (...args: never[]): unknown }, EM extends Record<keyof EM, unknown[]>> = C extends {
    new (...args: infer Args): infer Inst;
}
    ? Inst extends EventEmitter<infer EventMap>
        ? { new (...args: Args): Inst & EventEmitter<EM & EventMap> }
        : C
    : C;

export class MinecraftDebugSession extends (QuickJSDebugSession as ExtendEventMap<
    typeof QuickJSDebugSession,
    MinecraftDebugSessionEvents
>) {
    protocolVersion = ProtocolVersion.Unknown;
    protocolInfo?: ProtocolInfo;
    currentStat?: StatTree;
    currentTick = 0;
    constructor(connection: DebugConnection, protocolInfo?: ProtocolInfo) {
        super(connection);
        if (protocolInfo) {
            this.setProtocolInfo(protocolInfo);
        }
        connection.on('event:PrintEvent', (ev) => {
            this.emit('log', ev as LogEvent);
        });
        connection.on('event:ProtocolEvent', (ev) => {
            const protocolEvent = ev as ProtocolEvent;
            this.protocolVersion = protocolEvent.version;
            this.emit('protocol', protocolEvent);
            if (this.protocolInfo) {
                const protocolInfo = this.protocolInfo;
                this.connection.sendEnvelope('protocol', {
                    version: protocolInfo.version,
                    target_module_uuid: protocolInfo.targetModuleUuid,
                    passcode: protocolInfo.passcode,
                });
            }
        });
        const v1PathCache = new Map<string, string[]>();
        connection.on('event:StatEvent', (ev) => {
            const statEvent = ev as StatMessageV1Event;
            if (!this.currentStat) this.currentStat = {};
            const stat = mergeStatTreeNodeV1(this.currentStat, statEvent.stats, v1PathCache);
            this.emit('stat', { stat, tick: this.currentTick });
        });
        connection.on('event:StatEvent2', (ev) => {
            const statEvent = ev as StatMessageV2Event;
            if (!this.currentStat) this.currentStat = {};
            const stat = mergeStatTreeNodeV2(this.currentStat, statEvent.stats, statEvent.tick);
            this.currentTick = statEvent.tick;
            this.emit('stat', { stat, tick: statEvent.tick });
        });
        connection.on('event:ProfilerCapture', (ev) => {
            this.emit('profilerCapture', ev as ProfilerCaptureEvent);
        });
    }

    setProtocolInfo(protocolInfo: ProtocolInfo) {
        this.protocolInfo = protocolInfo;
    }

    setBreakpoints(fileName: string, breakpoints: BreakpointInfo[]) {
        if (this.protocolVersion >= ProtocolVersion.SupportBreakpointsAsRequest) {
            const breakpointLines = breakpoints.map((e) => e.line);
            return this.setBreakpointLines(fileName, breakpointLines);
        } else {
            super.setBreakpoints(fileName, breakpoints);
            const status: BreakpointStatus[] = breakpoints.map(() => ({ verified: true }));
            return status;
        }
    }

    sendMinecraftCommand(command: string, dimensionType?: string) {
        if (this.protocolVersion >= ProtocolVersion.SupportProfilerCaptures) {
            this.connection.sendEnvelope('minecraftCommand', {
                command: {
                    command,
                    dimension_type: dimensionType ?? 'overworld',
                },
            });
        } else if (this.protocolVersion >= ProtocolVersion.SupportPasscode) {
            this.connection.sendEnvelope('minecraftCommand', {
                command,
                dimension_type: dimensionType ?? 'overworld',
            });
        } else {
            throw new Error(`Client not supported`);
        }
    }

    sendStartProfiler(targetModuleUuid?: string) {
        if (this.protocolVersion < ProtocolVersion.SupportProfilerCaptures) {
            throw new Error(`Client not supported`);
        }
        const argTargetModuleUuid = targetModuleUuid ?? this.protocolInfo?.targetModuleUuid;
        if (!argTargetModuleUuid) {
            throw new Error(`Expect target module uuid`);
        }
        this.connection.sendEnvelope('startProfiler', {
            profiler: {
                target_module_uuid: argTargetModuleUuid,
            },
        });
    }

    sendStopProfiler(capturesPath: string, targetModuleUuid?: string) {
        if (this.protocolVersion < ProtocolVersion.SupportProfilerCaptures) {
            throw new Error(`Client not supported`);
        }
        const argTargetModuleUuid = targetModuleUuid ?? this.protocolInfo?.targetModuleUuid;
        if (!argTargetModuleUuid) {
            throw new Error(`Expect target module uuid`);
        }
        this.connection.sendEnvelope('stopProfiler', {
            profiler: {
                captures_path: capturesPath,
                target_module_uuid: argTargetModuleUuid,
            },
        });
    }
}
