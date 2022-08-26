import EventEmitter from "events";
import { Socket } from "net";

export abstract class DebugProtocol extends EventEmitter {
    close(): void;
    sendMessage(message: any): void;
    sendEnvelope(type: string, data: any): void;
    sendRequest(command: string, args: any, callback: (err?: any, result: any) => void): void;
    sendRequest(command: string, args?: any): Promise<any>;
}

export class QuickJSDebugProtocol extends DebugProtocol {
    constructor(socket: Socket);
};