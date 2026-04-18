"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.composeServerMiddleware = composeServerMiddleware;
function composeServerMiddleware(middleware1, middleware2) {
    return (call, context) => {
        return middleware1(Object.assign(Object.assign({}, call), { next: (request, context1) => {
                return middleware2(Object.assign(Object.assign({}, call), { request }), context1);
            } }), context);
    };
}
//# sourceMappingURL=composeServerMiddleware.js.map