const assert = require("assert").strict;
const net = require("net");
const util = require("util");
const { QuickJSDebugProtocol, QuickJSDebugSession } = require("../lib");

function main([port]) {
    const server = net.createServer(async (socket) => {
        const protocol = new QuickJSDebugProtocol(socket);
        const session = new QuickJSDebugSession(protocol);
        const topStack = await session.getTopStack();
        const target = {};
        const scopes = await topStack.getScopes();
        await Promise.all(scopes.map(async (scope) => {
            target[scope.name] = await scope.inspect({ inspectProto: true });
        }));
        process.stdout.write(`${util.inspect(target)}\n`);
        assert.equal(target.Global.JSON, target.Global.globalThis.JSON);
        session.resume();
        protocol.close();
        server.close();
    });
    server.listen(port);
    process.stdout.write(`Please connect to <host>:${server.address().port}\n`);
}

main(process.argv.slice(2));
