"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoutingStrategy = void 0;
var RoutingStrategy;
(function (RoutingStrategy) {
    RoutingStrategy["PRIORITY"] = "priority";
    RoutingStrategy["CAPABILITY"] = "capability";
    RoutingStrategy["LATENCY"] = "latency";
    RoutingStrategy["ROUND_ROBIN"] = "round_robin";
    RoutingStrategy["RANDOM"] = "random";
})(RoutingStrategy || (exports.RoutingStrategy = RoutingStrategy = {}));
