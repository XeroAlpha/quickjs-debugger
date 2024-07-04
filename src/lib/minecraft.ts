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
    parent_id: string;
    type: string;
    label: string;
    value: string;
}

export interface StatData {
    name: string;
    id: string;
    full_id: string;
    parent_id: string;
    parent_full_id: string;
    values: number[];
    tick: number;
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

export interface StatMessageEvent extends DebuggeeEvent {
    type: 'StatEvent2';
    tick: number;
    stats: StatDataModel[];
}

export class MinecraftDebugSession extends QuickJSDebugSession {
    protocolInfo?: ProtocolInfo;
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
        connection.on('StatEvent', (ev: StatMessageV1Event) => {
            this.emit('statV1', ev);
        });
        connection.on('StatEvent2', (ev: StatMessageEvent) => {
            this.emit('stat', ev);
        });
    }

    setProtocolInfo(protocolInfo: ProtocolInfo) {
        this.protocolInfo = protocolInfo;
    }
}

export interface MinecraftDebugSessionEventMap {
    log: (event: LogEvent) => void;
    protocol: (event: ProtocolEvent) => void;
    statV1: (event: StatMessageV1Event) => void;
    stat: (event: StatMessageEvent) => void;
}

export interface MinecraftDebugSession {
    on(eventName: 'stopped', listener: (event: StoppedEvent) => void): this;
    on(eventName: 'context', listener: (event: ContextEvent) => void): this;
    on(eventName: 'end', listener: () => void): this;
    on(eventName: 'log', listener: (event: LogEvent) => void): this;
    on(eventName: 'protocol', listener: (event: ProtocolEvent) => void): this;
    on(eventName: 'statV1', listener: (event: StatMessageV1Event) => void): this;
    on(eventName: 'stat', listener: (event: StatMessageEvent) => void): this;
    once(eventName: 'stopped', listener: (event: StoppedEvent) => void): this;
    once(eventName: 'context', listener: (event: ContextEvent) => void): this;
    once(eventName: 'end', listener: () => void): this;
    once(eventName: 'log', listener: (event: LogEvent) => void): this;
    once(eventName: 'protocol', listener: (event: ProtocolEvent) => void): this;
    once(eventName: 'statV1', listener: (event: StatMessageV1Event) => void): this;
    once(eventName: 'stat', listener: (event: StatMessageEvent) => void): this;
    off(eventName: 'stopped', listener: (event: StoppedEvent) => void): this;
    off(eventName: 'context', listener: (event: ContextEvent) => void): this;
    off(eventName: 'end', listener: () => void): this;
    off(eventName: 'log', listener: (event: LogEvent) => void): this;
    off(eventName: 'protocol', listener: (event: ProtocolEvent) => void): this;
    off(eventName: 'statV1', listener: (event: StatMessageV1Event) => void): this;
    off(eventName: 'stat', listener: (event: StatMessageEvent) => void): this;
    addListener(eventName: 'stopped', listener: (event: StoppedEvent) => void): this;
    addListener(eventName: 'context', listener: (event: ContextEvent) => void): this;
    addListener(eventName: 'end', listener: () => void): this;
    addListener(eventName: 'log', listener: (event: LogEvent) => void): this;
    addListener(eventName: 'protocol', listener: (event: ProtocolEvent) => void): this;
    addListener(eventName: 'statV1', listener: (event: StatMessageV1Event) => void): this;
    addListener(eventName: 'stat', listener: (event: StatMessageEvent) => void): this;
    removeListener(eventName: 'stopped', listener: (event: StoppedEvent) => void): this;
    removeListener(eventName: 'context', listener: (event: ContextEvent) => void): this;
    removeListener(eventName: 'end', listener: () => void): this;
    removeListener(eventName: 'log', listener: (event: LogEvent) => void): this;
    removeListener(eventName: 'protocol', listener: (event: ProtocolEvent) => void): this;
    removeListener(eventName: 'statV1', listener: (event: StatMessageV1Event) => void): this;
    removeListener(eventName: 'stat', listener: (event: StatMessageEvent) => void): this;
    emit(eventName: 'stopped', event: StoppedEvent): boolean;
    emit(eventName: 'context', event: ContextEvent): boolean;
    emit(eventName: 'end'): boolean;
    emit(eventName: 'log', event: LogEvent): boolean;
    emit(eventName: 'protocol', event: ProtocolEvent): boolean;
    emit(eventName: 'statV1', event: StatMessageV1Event): boolean;
    emit(eventName: 'stat', event: StatMessageEvent): boolean;
}
