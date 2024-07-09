import { DebugConnection, DebuggeeEvent } from './connection.js';
import { ContextEvent, QuickJSDebugSession, StoppedEvent } from './session.js';

export interface ProtocolInfo {
    version: number;
    targetModuleUuid?: string;
}

export enum LogLevel {
    Verbose = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
    Fatal = 4
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

export interface StatDataV1 {
    id: string;
    parent_id?: string;
    type?: string;
    label?: string;
    value?: string | number;
}

export interface StatDataModel {
    name: string;
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
            currentTarget = newTargetOwner.children ?? (newTargetOwner.children = {});
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
        if (statData.children) {
            const children = existed.children ?? (existed.children = {});
            mergeStatTreeNodeV2(children, statData.children, tick);
        }
    }
}

export class MinecraftDebugSession extends QuickJSDebugSession {
    protocolInfo?: ProtocolInfo;
    currentStat: StatTree | null = null;
    currentTick = 0;
    constructor(connection: DebugConnection) {
        super(connection);
        connection.on('PrintEvent', (ev: LogEvent) => {
            this.emit('log', ev);
        });
        connection.on('ProtocolEvent', (ev: ProtocolEvent) => {
            this.emit('protocol', ev);
            if (this.protocolInfo) {
                const protocolInfo = this.protocolInfo;
                this.connection.sendMessage({
                    type: 'protocol',
                    version: protocolInfo.version,
                    target_module_uuid: protocolInfo.targetModuleUuid
                });
            }
        });
        const v1PathCache = new Map<string, string[]>();
        connection.on('StatEvent', (ev: StatMessageV1Event) => {
            const stat = this.currentStat ?? (this.currentStat = {});
            mergeStatTreeNodeV1(stat, ev.stats, v1PathCache);
            this.emit('stat', { stat, tick: this.currentTick });
        });
        connection.on('StatEvent2', (ev: StatMessageV2Event) => {
            const stat = this.currentStat ?? (this.currentStat = {});
            this.currentTick = ev.tick;
            mergeStatTreeNodeV2(stat, ev.stats, ev.tick);
            this.emit('stat', { stat, tick: ev.tick });
        });
    }

    setProtocolInfo(protocolInfo: ProtocolInfo) {
        this.protocolInfo = protocolInfo;
    }
}

export interface MinecraftDebugSessionEventMap {
    log: (event: LogEvent) => void;
    protocol: (event: ProtocolEvent) => void;
    stat: (event: StatMessageV2Event) => void;
}

export interface MinecraftDebugSession {
    on(eventName: 'stopped', listener: (event: StoppedEvent) => void): this;
    on(eventName: 'context', listener: (event: ContextEvent) => void): this;
    on(eventName: 'end', listener: () => void): this;
    on(eventName: 'log', listener: (event: LogEvent) => void): this;
    on(eventName: 'protocol', listener: (event: ProtocolEvent) => void): this;
    on(eventName: 'stat', listener: (event: StatEvent) => void): this;
    once(eventName: 'stopped', listener: (event: StoppedEvent) => void): this;
    once(eventName: 'context', listener: (event: ContextEvent) => void): this;
    once(eventName: 'end', listener: () => void): this;
    once(eventName: 'log', listener: (event: LogEvent) => void): this;
    once(eventName: 'protocol', listener: (event: ProtocolEvent) => void): this;
    once(eventName: 'stat', listener: (event: StatEvent) => void): this;
    off(eventName: 'stopped', listener: (event: StoppedEvent) => void): this;
    off(eventName: 'context', listener: (event: ContextEvent) => void): this;
    off(eventName: 'end', listener: () => void): this;
    off(eventName: 'log', listener: (event: LogEvent) => void): this;
    off(eventName: 'protocol', listener: (event: ProtocolEvent) => void): this;
    off(eventName: 'stat', listener: (event: StatEvent) => void): this;
    addListener(eventName: 'stopped', listener: (event: StoppedEvent) => void): this;
    addListener(eventName: 'context', listener: (event: ContextEvent) => void): this;
    addListener(eventName: 'end', listener: () => void): this;
    addListener(eventName: 'log', listener: (event: LogEvent) => void): this;
    addListener(eventName: 'protocol', listener: (event: ProtocolEvent) => void): this;
    addListener(eventName: 'stat', listener: (event: StatEvent) => void): this;
    removeListener(eventName: 'stopped', listener: (event: StoppedEvent) => void): this;
    removeListener(eventName: 'context', listener: (event: ContextEvent) => void): this;
    removeListener(eventName: 'end', listener: () => void): this;
    removeListener(eventName: 'log', listener: (event: LogEvent) => void): this;
    removeListener(eventName: 'protocol', listener: (event: ProtocolEvent) => void): this;
    removeListener(eventName: 'stat', listener: (event: StatEvent) => void): this;
    emit(eventName: 'stopped', event: StoppedEvent): boolean;
    emit(eventName: 'context', event: ContextEvent): boolean;
    emit(eventName: 'end'): boolean;
    emit(eventName: 'log', event: LogEvent): boolean;
    emit(eventName: 'protocol', event: ProtocolEvent): boolean;
    emit(eventName: 'stat', event: StatEvent): boolean;
}
