// engine_cli.cpp
// Runs the planner from the command line, no web server needed.
// Handy for testing the algorithms and for checking numbers in your report.
//
//   engine_cli towns
//   engine_cli plan <seed> <thr> <cap> <algo> [pretty] [key=value ...]
//   engine_cli csv  <seed> <thr> <cap> <algo> [key=value ...]
//     optional keys: crit warn fleet shift balance
//     example: engine_cli plan 1 50 10 sav2 pretty fleet=3 balance=1
#include <cstdlib>
#include <iostream>
#include <string>

#include "engine.hpp"

int main(int argc, char** argv) {
    try {
        waste::Engine engine;
        std::string cmd = argc > 1 ? argv[1] : "";
        if (cmd == "towns") {
            std::cout << engine.towns().dump() << "\n";
            return 0;
        }
        if ((cmd == "plan" || cmd == "csv") && argc >= 6) {
            waste::Params p;
            p.seed = std::stoi(argv[2]);
            p.thr = std::stoi(argv[3]);
            p.cap = std::stod(argv[4]);
            p.algo = argv[5];
            bool pretty = false;
            for (int i = 6; i < argc; ++i) {
                std::string a = argv[i];
                if (a == "pretty") { pretty = true; continue; }
                size_t eq = a.find('=');
                if (eq == std::string::npos) continue;
                std::string k = a.substr(0, eq), v = a.substr(eq + 1);
                if (k == "crit") p.crit = std::stoi(v);
                else if (k == "warn") p.warn = std::stoi(v);
                else if (k == "fleet") p.fleet = std::stoi(v);
                else if (k == "shift") p.shift = std::stod(v);
                else if (k == "balance") p.balance = v == "1";
            }
            if (cmd == "csv") { std::cout << engine.csv(p); return 0; }
            auto j = engine.plan(p);
            std::cout << (pretty ? j.dump(2) : j.dump()) << "\n";
            return 0;
        }
        std::cerr << "usage:\n  engine_cli towns\n  engine_cli plan <seed> <thr> <cap> <algo> [pretty] [key=value ...]\n"
                     "  engine_cli csv <seed> <thr> <cap> <algo> [key=value ...]\n"
                     "  algo is one of: dc-lc, gk-lc, gk-fifo, gk-lifo; keys: crit warn fleet shift balance\n";
        return 2;
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << "\n";
        return 1;
    }
}
