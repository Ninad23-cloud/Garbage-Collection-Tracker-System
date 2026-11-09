// main.cpp
// Local web server: serves the page from ./public and exposes the planner as a small REST API.
//
//   GET /api/health
//   GET /api/towns
//   GET /api/plan?seed=1&thr=50&cap=10&algo=gk-lc[&crit=80&warn=60&fleet=6&shift=10&balance=0]
//   GET /api/export?...same query...   (CSV download of the plan)
//
// The page and the API come from the same address, so the browser needs no CORS setup.
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>

#include "httplib.h"  // cpp-httplib, single header, see README
#include "engine.hpp"

namespace {

int intParam(const httplib::Request& req, const char* key, int fallback) {
    if (!req.has_param(key)) return fallback;
    try { return std::stoi(req.get_param_value(key)); }
    catch (const std::exception&) { throw std::invalid_argument(std::string(key) + " must be a whole number"); }
}

double numParam(const httplib::Request& req, const char* key, double fallback) {
    if (!req.has_param(key)) return fallback;
    try { return std::stod(req.get_param_value(key)); }
    catch (const std::exception&) { throw std::invalid_argument(std::string(key) + " must be a number"); }
}

waste::Params paramsFrom(const httplib::Request& req) {
    waste::Params p;
    p.seed = intParam(req, "seed", p.seed);
    p.thr = intParam(req, "thr", p.thr);
    p.cap = numParam(req, "cap", p.cap);
    if (req.has_param("algo")) p.algo = req.get_param_value("algo");
    p.crit = intParam(req, "crit", p.crit);
    p.warn = intParam(req, "warn", p.warn);
    p.fleet = intParam(req, "fleet", p.fleet);
    p.shift = numParam(req, "shift", p.shift);
    p.balance = intParam(req, "balance", 0) != 0;
    return p;
}

void sendJson(httplib::Response& res, int status, const waste::json& body) {
    res.status = status;
    res.set_content(body.dump(), "application/json");
}

}  // namespace

int main(int argc, char** argv) {
    int port = argc > 1 ? std::atoi(argv[1]) : 8080;
    if (const char* env_port = std::getenv("PORT")) {
        port = std::stoi(env_port);
    }

    std::string publicDir = argc > 2 ? argv[2] : "public";

    waste::Engine engine;
    httplib::Server svr;

    // Lets the page also work when opened from another origin (for example VS Code Live Server).
    svr.set_default_headers({{"Access-Control-Allow-Origin", "*"}});

    if (!svr.set_mount_point("/", publicDir)) {
        std::cerr << "Warning: folder '" << publicDir << "' not found. Run the server from the project folder,\n"
                  << "or pass the path:  server 8080 /path/to/public\n";
    }

    svr.Get("/api/health", [](const httplib::Request&, httplib::Response& res) {
        sendJson(res, 200, {{"status", "ok"}});
    });

    svr.Get("/api/towns", [&engine](const httplib::Request&, httplib::Response& res) {
        sendJson(res, 200, engine.towns());
    });

    svr.Get("/api/plan", [&engine](const httplib::Request& req, httplib::Response& res) {
        try {
            sendJson(res, 200, engine.plan(paramsFrom(req)));
        } catch (const std::exception& e) {
            sendJson(res, 400, {{"error", e.what()}});
        }
    });

    svr.Get("/api/export", [&engine](const httplib::Request& req, httplib::Response& res) {
        try {
            waste::Params p = paramsFrom(req);
            res.set_header("Content-Disposition", "attachment; filename=\"pune-collection-plan-day" + std::to_string(p.seed) + ".csv\"");
            res.set_content(engine.csv(p), "text/csv; charset=utf-8");
        } catch (const std::exception& e) {
            sendJson(res, 400, {{"error", e.what()}});
        }
    });

    std::string host = "0.0.0.0";
    if (const char* env_host = std::getenv("HOST")) {
        host = env_host;
    }

    std::cout << "Pune waste planner running on " << host << ":" << port << ".\n"
              << "Open http://localhost:" << port << " in your browser. Press Ctrl+C to stop.\n";

    // Use "0.0.0.0" to allow external connections and pass Render port health checks
    if (!svr.listen(host.c_str(), port)) {
        std::cerr << "Could not start on " << host << ":" << port << ". Is another program using it?\n";
        return 1;
    }
    return 0;
}
