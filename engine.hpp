// engine.hpp
// All the DAA logic for the Pune district waste-collection planner.
// No networking in this file, so it can be tested on its own (see engine_cli.cpp).
// Every algorithm used here comes from the course syllabus:
//
//   Module II   Divide and Conquer   split the towns by map position until each group fits one truck
//               Greedy               Kruskal-style joining of the closest towns while the truck has room
//               Merge sort, Quick sort   used for every sorting step below
//   Module III  Branch and Bound     shortest tour for each truck (Travelling Salesperson), FIFO, LIFO and LC
//   Module IV   0/1 Knapsack (DP)    which towns to keep when the fleet cannot carry everything
//   Module V    Kruskal              builds the road network (minimum spanning tree + nearest-neighbour roads)
//               Prim                 minimum spanning tree: lower bound and starting tour for Branch and Bound
//               Dijkstra (heap)      shortest road distance between every pair of towns
//               Bellman-Ford         cross-checks Dijkstra
//
// Complexities (n = towns in one group, V = towns, E = road links):
//   Merge sort / Quick sort   O(n log n) / O(n log n) average
//   Kruskal (sorted links)    O(E log E)
//   Dijkstra (heap)           O((V+E) log V) per source
//   Bellman-Ford              O(V*E)
//   Prim                      O(n^2)
//   0/1 Knapsack              O(n * W)   (W = fleet capacity in 0.1 t units)
//   Branch and Bound          O(n!) worst case, much less with the bound; capped by a node limit
//   Divide and Conquer split  O(n log n) per level
#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <functional>
#include <limits>
#include <map>
#include <numeric>
#include <queue>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "json.hpp"

namespace waste {

using json = nlohmann::json;
using Routes = std::vector<std::vector<int>>;

constexpr double TONNES_PER_BIN = 0.25;  // tonnes held by one full bin
constexpr double SPEED_KMH = 38.0;       // average truck speed
constexpr double STOP_MIN = 10.0;        // minutes spent at each stop
constexpr double ROAD_FACTOR = 1.25;     // road length = straight line * this
// Operating assumptions (demo values, shown to the user as assumptions):
constexpr double FUEL_L_PER_KM = 0.35;   // diesel compactor truck, about 2.9 km per litre
constexpr double DIESEL_INR_PER_L = 92.0;
constexpr double CO2_KG_PER_L = 2.68;    // kg CO2 per litre of diesel burned
constexpr double START_MIN = 360.0;      // trucks leave the yard at 06:00
constexpr int REPS = 5;                  // each algorithm is timed over this many runs (mean)
constexpr long BB_MAX_NODES = 6000;      // Branch and Bound stops after this many nodes per route
constexpr double INF = std::numeric_limits<double>::infinity();
constexpr double PI = 3.14159265358979323846;

struct Town {
    std::string name;
    double lat, lon;
    int bins;           // number of bins in the town (0 for the depot)
    bool depot;
    std::string label;  // where the front end puts the name: l, r, t, b
    std::string note;
    double capT() const { return bins * TONNES_PER_BIN; }
};

struct Params {
    int seed = 1;            // which sample day (decides the bin fill levels)
    int thr = 50;            // collect a town when its bins are at least this full (%)
    double cap = 10;         // truck capacity, tonnes
    std::string algo = "gk-lc";
    int crit = 80;           // red: at or above this %, always collected
    int warn = 60;           // amber: at or above this % (but below crit)
    int fleet = 6;           // most trucks the depot owns
    double shift = 10;       // longest allowed working day, hours
    bool balance = false;    // split any route longer than the shift limit into two trucks
};

struct Stop {
    int id;
    double arr, dep;   // minutes after the 06:00 departure
    double km;         // kilometres driven when the truck arrives here
    double loadAfter;  // tonnes on board after emptying this town
};

struct Row {
    std::vector<int> nodes;  // town indices in visiting order (depot excluded)
    std::vector<Stop> stops;
    double km = 0, load = 0, hours = 0, returnMin = 0;
};

struct Stats {
    std::vector<Row> rows;
    double km = 0, hours = 0, makespan = 0;
    int trucks = 0;
};

struct Unserved {
    int id;
    std::string reason;
};

struct Outcome {  // one algorithm's answer for one day
    Routes routes;
    std::vector<Unserved> unserved;
    double execMs = 0;
    long nodes = 0;        // Branch and Bound nodes examined (all routes together)
    bool capped = false;   // true if some route hit the node limit
};

struct Res {      // an Outcome plus every number worked out from it
    std::string id, name;
    Outcome out;
    Stats st;
    int served = 0, capViol = 0, shiftViol = 0, longestTruck = -1;
    double directKm = 0, lowerBound = 0, fuelL = 0, cost = 0, co2 = 0;
    double util = 0, imbalance = 1, longestShare = 0;
};

// Small seeded random generator (mulberry32), so every run of "day N" gives the same fill levels.
class Mulberry {
    uint32_t a_;
public:
    explicit Mulberry(uint32_t seed) : a_(seed) {}
    double next() {
        a_ += 0x6D2B79F5u;
        uint32_t t = (a_ ^ (a_ >> 15)) * (1u | a_);
        t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
        return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
    }
};

// Merge sort: stable, O(n log n). Used for the road links (Kruskal) and the neighbour lists.
template <class T, class Less>
void mergeRec(std::vector<T>& a, std::vector<T>& tmp, size_t lo, size_t hi, Less less) {
    if (hi - lo < 2) return;
    size_t mid = (lo + hi) / 2;
    mergeRec(a, tmp, lo, mid, less);
    mergeRec(a, tmp, mid, hi, less);
    size_t i = lo, j = mid, k = lo;
    while (i < mid && j < hi) tmp[k++] = less(a[j], a[i]) ? a[j++] : a[i++];
    while (i < mid) tmp[k++] = a[i++];
    while (j < hi) tmp[k++] = a[j++];
    for (k = lo; k < hi; ++k) a[k] = tmp[k];
}
template <class T, class Less>
void mergeSort(std::vector<T>& a, Less less) {
    std::vector<T> tmp(a.size());
    mergeRec(a, tmp, 0, a.size(), less);
}

// Quick sort (Hoare partition, middle pivot, recurse into the smaller half): O(n log n) on average.
// Used to order towns along the map axis for Divide and Conquer.
template <class T, class Less>
void quickSort(std::vector<T>& a, long lo, long hi, Less less) {
    while (lo < hi) {
        T pivot = a[lo + (hi - lo) / 2];
        long i = lo, j = hi;
        while (i <= j) {
            while (less(a[i], pivot)) ++i;
            while (less(pivot, a[j])) --j;
            if (i <= j) { std::swap(a[i], a[j]); ++i; --j; }
        }
        if (j - lo < hi - i) { quickSort(a, lo, j, less); lo = i; }
        else { quickSort(a, i, hi, less); hi = j; }
    }
}

class Engine {
public:
    Engine() {
        initTowns();
        N_ = static_cast<int>(T_.size());
        adj_.assign(N_, {});
        buildGraph();
        allPairs();
        bfOk_ = bellmanFordAgrees();
        initAlgos();
    }

    // Static data the page needs once: towns, road links, algorithm list, assumptions.
    json towns() const {
        json arr = json::array();
        for (int i = 0; i < N_; ++i) {
            const Town& t = T_[i];
            arr.push_back({{"id", i}, {"name", t.name}, {"lat", t.lat}, {"lon", t.lon},
                           {"bins", t.bins}, {"capT", t.capT()}, {"note", t.note},
                           {"depot", t.depot}, {"label", t.label}});
        }
        json edges = json::array();
        for (const Edge& e : edges_) edges.push_back(json::array({e.a, e.b, e.w}));
        json algos = json::array();
        for (const AlgoDef& a : algos_) algos.push_back({{"id", a.id}, {"name", a.name}});
        return {{"towns", arr},
                {"edges", edges},
                {"algos", algos},
                {"checks", {{"dijkstraMatchesBellmanFord", bfOk_}}},
                {"constants", {{"tonnesPerBin", TONNES_PER_BIN}, {"speedKmh", SPEED_KMH},
                               {"stopMinutes", STOP_MIN}, {"roadFactor", ROAD_FACTOR},
                               {"fuelLPerKm", FUEL_L_PER_KM}, {"dieselInrPerL", DIESEL_INR_PER_L},
                               {"co2KgPerL", CO2_KG_PER_L}, {"startMin", START_MIN}}}};
    }

    // One day's plan. Runs every algorithm on the same data so the page can compare them.
    json plan(const Params& P) const {
        auto t0 = std::chrono::steady_clock::now();
        Day d = compute(P);
        json results = json::object();
        for (size_t k = 0; k < d.res.size(); ++k) results[d.res[k].id] = resJson(d, d.res[k]);

        // Second baseline: this method with every town collected, fleet unlimited.
        const AlgoDef& chosen = algos_[d.chosen];
        std::vector<int> all;
        for (int i = 1; i < N_; ++i) all.push_back(i);
        Params open = P;
        open.fleet = 1000;
        open.balance = false;
        Outcome allOut = solve(chosen, all, d.q, d.fills, open, 1);
        Stats allSt = stats(allOut.routes, d.q);

        json tiers = json::array();
        for (int i = 0; i < N_; ++i) tiers.push_back(tierOf(d.fills[i], P));
        json warns = warningsFor(d, d.res[d.chosen], P);
        json balanceNote = nullptr;
        if (P.balance) {  // what the same method gives without balancing, so the page can show the trade-off
            Params plain = P;
            plain.balance = false;
            Outcome o = solve(chosen, d.ids, d.q, d.fills, plain, 1);
            Stats s0 = stats(o.routes, d.q);
            balanceNote = {{"kmWithout", rnd(s0.km, 2)}, {"makespanWithout", rnd(s0.makespan, 3)}, {"trucksWithout", s0.trucks}};
        }
        double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        return {{"params", {{"seed", P.seed}, {"thr", P.thr}, {"cap", P.cap}, {"algo", P.algo}, {"crit", P.crit},
                            {"warn", P.warn}, {"fleet", P.fleet}, {"shift", P.shift}, {"balance", P.balance}}},
                {"fills", d.fills},
                {"tiers", tiers},
                {"q", d.q},
                {"collected", d.ids},
                {"results", results},
                {"winner", winnerJson(d)},
                {"warnings", warns},
                {"balanceNote", balanceNote},
                {"baseline", {{"km", rnd(allSt.km, 2)}, {"trucks", allSt.trucks}, {"hours", rnd(allSt.hours, 2)},
                              {"fuelL", rnd(allSt.km * FUEL_L_PER_KM, 1)}}},
                {"computeMs", ms}};
    }

    // The same plan as a spreadsheet-friendly CSV (one row per stop, summary at the top).
    std::string csv(const Params& P) const {
        Day d = compute(P);
        const Res& r = d.res[d.chosen];
        std::string o;
        auto line = [&o](const std::string& s) { o += s + "\r\n"; };
        auto q = [](std::string s) {
            std::string e = "\"";
            for (char c : s) { if (c == '"') e += '"'; e += c; }
            return e + "\"";
        };
        line("Pune waste collection plan");
        line("Method," + q(r.name));
        line("Sample day," + std::to_string(P.seed));
        line("Collect at or above (%)," + std::to_string(P.thr) + ",Critical (%)," + std::to_string(P.crit));
        line("Truck capacity (t)," + fmt(P.cap, 1) + ",Fleet limit," + std::to_string(P.fleet) +
             ",Shift limit (h)," + fmt(P.shift, 1));
        line("Towns collected," + std::to_string(r.served) + ",Towns not served," + std::to_string(r.out.unserved.size()));
        line("Trucks used," + std::to_string(r.st.trucks) + ",Total km," + fmt(r.st.km, 1) +
             ",Fuel (L)," + fmt(r.fuelL, 1) + ",Fuel cost (INR)," + fmt(r.cost, 0) + ",CO2 (kg)," + fmt(r.co2, 1));
        line("Distance saved vs one truck per town (km)," + fmt(r.directKm - r.st.km, 1));
        line("Assumptions,diesel " + fmt(FUEL_L_PER_KM, 2) + " L/km; INR " + fmt(DIESEL_INR_PER_L, 0) +
             " per L; " + fmt(CO2_KG_PER_L, 2) + " kg CO2 per L; " + fmt(SPEED_KMH, 0) + " km/h; " +
             fmt(STOP_MIN, 0) + " min per stop; road km = straight line x " + fmt(ROAD_FACTOR, 2));
        line("");
        line("Truck,Stop,Town,Taluka / area,Bins full (%),Collected (t),Arrive,Depart,Km driven,Load on board (t)");
        for (size_t k = 0; k < r.st.rows.size(); ++k) {
            const Row& row = r.st.rows[k];
            line(std::to_string(k + 1) + ",0,Central yard,Depot,,,," + hhmm(0) + ",0,0");
            int s = 0;
            for (const Stop& st : row.stops) {
                ++s;
                line(std::to_string(k + 1) + "," + std::to_string(s) + "," + q(T_[st.id].name) + "," + q(T_[st.id].note) +
                     "," + std::to_string(d.fills[st.id]) + "," + fmt(d.q[st.id], 2) + "," + hhmm(st.arr) + "," +
                     hhmm(st.dep) + "," + fmt(st.km, 1) + "," + fmt(st.loadAfter, 2));
            }
            line(std::to_string(k + 1) + "," + std::to_string(s + 1) + ",Back at yard,Depot,,," + hhmm(row.returnMin) +
                 ",," + fmt(row.km, 1) + ",0");
        }
        if (!r.out.unserved.empty()) {
            line("");
            line("Not served,Town,Bins full (%),Reason");
            for (const Unserved& u : r.out.unserved)
                line("," + q(T_[u.id].name) + "," + std::to_string(d.fills[u.id]) + "," + q(u.reason));
        }
        return o;
    }

private:
    struct Edge { int a, b; double w; };
    struct AlgoDef {
        std::string id, name;
        bool divide;   // true: Divide and Conquer groups; false: Greedy (Kruskal) groups
        int strategy;  // Branch and Bound order: 0 = FIFO, 1 = LIFO, 2 = LC (least cost first)
    };

    std::vector<Town> T_;
    int N_ = 0;
    std::vector<Edge> edges_;
    std::vector<std::vector<std::pair<int, double>>> adj_;
    std::vector<std::vector<double>> D_;   // D_[i][j] = shortest road km from i to j
    std::vector<std::vector<int>> prev_;   // prev_[s][v] = node before v on the path from s
    std::vector<AlgoDef> algos_;
    bool bfOk_ = true;  // Bellman-Ford distances equal Dijkstra distances

    // ---------- data ----------
    void initTowns() {
        // Pune district: the two big urban centres plus the main town of each taluka.
        // Positions are approximate (to about 1 km); bin counts are demo values (the two cities have the most bins).
        T_ = {
            {"Central yard (Hadapsar)", 18.490, 73.960, 0, true, "r", "Depot"},
            {"Pune", 18.520, 73.856, 30, false, "b", "Pune Municipal Corporation area"},
            {"Pimpri-Chinchwad", 18.629, 73.799, 24, false, "r", "Industrial city"},
            {"Vadgaon Maval", 18.760, 73.650, 6, false, "t", "Maval taluka"},
            {"Paud", 18.510, 73.620, 6, false, "r", "Mulshi taluka"},
            {"Rajgurunagar", 18.863, 73.887, 7, false, "r", "Khed taluka"},
            {"Manchar", 19.003, 73.943, 5, false, "r", "Ambegaon taluka"},
            {"Junnar", 19.209, 73.875, 8, false, "r", "Junnar taluka"},
            {"Shirur", 18.827, 74.376, 9, false, "r", "Shirur taluka"},
            {"Daund", 18.466, 74.583, 8, false, "r", "Daund taluka"},
            {"Baramati", 18.151, 74.577, 12, false, "t", "Baramati taluka"},
            {"Indapur", 18.116, 75.019, 7, false, "l", "Indapur taluka"},
            {"Saswad", 18.348, 74.034, 8, false, "r", "Purandar taluka"},
            {"Bhor", 18.150, 73.846, 5, false, "r", "Bhor taluka"},
            {"Velhe", 18.287, 73.620, 3, false, "r", "Velhe taluka"},
            {"Lonavala", 18.748, 73.407, 7, false, "r", "Maval taluka, hill town"},
            {"Talegaon Dabhade", 18.736, 73.676, 7, false, "r", "Maval taluka"},
            {"Chakan", 18.760, 73.863, 8, false, "r", "Khed taluka, auto belt"},
            {"Alandi", 18.677, 73.898, 5, false, "r", "Khed taluka, pilgrim town"},
            {"Hinjewadi", 18.591, 73.739, 9, false, "l", "Mulshi taluka, IT park"},
            {"Wagholi", 18.580, 73.980, 8, false, "r", "Haveli taluka, fast growing"},
            {"Uruli Kanchan", 18.473, 74.142, 5, false, "r", "Haveli taluka"},
            {"Yavat", 18.462, 74.335, 4, false, "r", "Daund taluka"},
            {"Jejuri", 18.276, 74.159, 5, false, "r", "Purandar taluka, temple town"},
            {"Narayangaon", 19.129, 73.970, 5, false, "r", "Junnar taluka"},
            {"Shikrapur", 18.690, 74.130, 5, false, "r", "Shirur taluka"},
            {"Bhigwan", 18.310, 74.786, 4, false, "r", "Indapur taluka"},
        };
    }

    // ---------- graph ----------
    static double hav(const Town& a, const Town& b) {
        const double r = PI / 180.0;
        double dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r;
        double h = std::sin(dl / 2) * std::sin(dl / 2) +
                   std::cos(a.lat * r) * std::cos(b.lat * r) * std::sin(dn / 2) * std::sin(dn / 2);
        return 2 * 6371.0 * std::asin(std::sqrt(h));
    }

    // Road network. Kruskal's algorithm sorts every possible link by length (merge sort) and keeps a link
    // whenever it joins two separate parts (Union-Find): the result is a minimum spanning tree, so every
    // town can be reached. Each town is then also joined to its 3 nearest neighbours, which adds alternative roads.
    void buildGraph() {
        std::vector<int> parent(N_);
        std::iota(parent.begin(), parent.end(), 0);
        auto find = [&](int x) {
            while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        };
        std::set<std::pair<int, int>> seen;
        auto add = [&](int a, int b) {
            if (!seen.insert({std::min(a, b), std::max(a, b)}).second) return;
            double w = hav(T_[a], T_[b]) * ROAD_FACTOR;
            edges_.push_back({a, b, w});
            adj_[a].push_back({b, w});
            adj_[b].push_back({a, w});
            parent[find(a)] = find(b);
        };
        struct Cand { int i, j; double d; };
        std::vector<Cand> all;
        for (int i = 0; i < N_; ++i)
            for (int j = i + 1; j < N_; ++j) all.push_back({i, j, hav(T_[i], T_[j])});
        mergeSort(all, [](const Cand& x, const Cand& y) { return x.d < y.d; });
        for (const Cand& c : all) if (find(c.i) != find(c.j)) add(c.i, c.j);  // Kruskal
        for (int i = 0; i < N_; ++i) {
            std::vector<std::pair<int, double>> near;
            for (int j = 0; j < N_; ++j) if (j != i) near.push_back({j, hav(T_[i], T_[j])});
            mergeSort(near, [](const auto& x, const auto& y) { return x.second < y.second; });
            for (int k = 0; k < 3; ++k) add(i, near[k].first);
        }
    }

    // Bellman-Ford from the yard: relax every road V-1 times. Used to cross-check Dijkstra.
    bool bellmanFordAgrees() const {
        std::vector<double> d(N_, INF);
        d[0] = 0;
        for (int round = 0; round < N_ - 1; ++round) {
            bool any = false;
            for (const Edge& e : edges_) {
                if (d[e.a] + e.w < d[e.b] - 1e-12) { d[e.b] = d[e.a] + e.w; any = true; }
                if (d[e.b] + e.w < d[e.a] - 1e-12) { d[e.a] = d[e.b] + e.w; any = true; }
            }
            if (!any) break;
        }
        for (int i = 0; i < N_; ++i) if (std::fabs(d[i] - D_[0][i]) > 1e-6) return false;
        return true;
    }

    // Dijkstra with a binary min-heap (std::priority_queue).
    void dijkstra(int src, std::vector<double>& dist, std::vector<int>& prv) const {
        dist.assign(N_, INF);
        prv.assign(N_, -1);
        using P = std::pair<double, int>;
        std::priority_queue<P, std::vector<P>, std::greater<P>> pq;
        dist[src] = 0;
        pq.push({0.0, src});
        while (!pq.empty()) {
            auto [d, u] = pq.top();
            pq.pop();
            if (d > dist[u]) continue;  // stale heap entry
            for (const auto& [v, w] : adj_[u]) {
                if (d + w < dist[v]) {
                    dist[v] = d + w;
                    prv[v] = u;
                    pq.push({dist[v], v});
                }
            }
        }
    }

    void allPairs() {
        D_.assign(N_, {});
        prev_.assign(N_, {});
        for (int s = 0; s < N_; ++s) dijkstra(s, D_[s], prev_[s]);
    }

    std::vector<int> pathBetween(int a, int b) const {
        std::vector<int> p{b};
        while (p.back() != a) p.push_back(prev_[a][p.back()]);
        std::reverse(p.begin(), p.end());
        return p;
    }

    // Road-node sequence for one truck: yard -> stops -> yard, following real links.
    std::vector<int> fullPath(const std::vector<int>& nodes) const {
        std::vector<int> seq{0};
        seq.insert(seq.end(), nodes.begin(), nodes.end());
        seq.push_back(0);
        std::vector<int> pts;
        for (size_t a = 0; a + 1 < seq.size(); ++a) {
            std::vector<int> seg = pathBetween(seq[a], seq[a + 1]);
            if (a > 0) seg.erase(seg.begin());
            pts.insert(pts.end(), seg.begin(), seg.end());
        }
        return pts;
    }

    // ---------- routing ----------
    double routeKm(const std::vector<int>& r) const {
        if (r.empty()) return 0;
        double d = D_[0][r.front()];
        for (size_t i = 0; i + 1 < r.size(); ++i) d += D_[r[i]][r[i + 1]];
        return d + D_[r.back()][0];
    }

    // ---------- grouping the towns onto trucks ----------
    // Greedy (Kruskal style): sort every pair of towns by road distance (merge sort), then join the closest
    // pairs into one group as long as the group's waste still fits the truck. Union-Find tracks the groups.
    std::vector<std::vector<int>> greedyGroups(const std::vector<int>& ids, const std::vector<double>& q, double cap) const {
        size_t n = ids.size();
        struct E { int a, b; double d; };
        std::vector<E> edges;
        for (size_t a = 0; a < n; ++a)
            for (size_t b = a + 1; b < n; ++b) edges.push_back({static_cast<int>(a), static_cast<int>(b), D_[ids[a]][ids[b]]});
        mergeSort(edges, [](const E& x, const E& y) { return x.d < y.d; });
        std::vector<int> parent(n);
        std::iota(parent.begin(), parent.end(), 0);
        std::vector<double> load(n);
        for (size_t a = 0; a < n; ++a) load[a] = q[ids[a]];
        auto find = [&](int x) {
            while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        };
        for (const E& e : edges) {
            int ra = find(e.a), rb = find(e.b);
            if (ra == rb || load[ra] + load[rb] > cap + 1e-9) continue;
            parent[ra] = rb;
            load[rb] += load[ra];
        }
        std::map<int, std::vector<int>> groups;
        for (size_t a = 0; a < n; ++a) groups[find(static_cast<int>(a))].push_back(ids[a]);
        std::vector<std::vector<int>> out;
        for (auto& kv : groups) out.push_back(kv.second);
        return out;
    }

    // Order towns along whichever map direction (north-south or east-west) they spread over more. Quick sort.
    void sortAlongLongerAxis(std::vector<int>& s) const {
        if (s.size() < 2) return;
        double lo1 = 1e9, hi1 = -1e9, lo2 = 1e9, hi2 = -1e9;
        for (int i : s) {
            lo1 = std::min(lo1, T_[i].lat); hi1 = std::max(hi1, T_[i].lat);
            lo2 = std::min(lo2, T_[i].lon); hi2 = std::max(hi2, T_[i].lon);
        }
        double spanLat = (hi1 - lo1) * 111.2, spanLon = (hi2 - lo2) * 111.2 * std::cos((lo1 + hi1) / 2 * PI / 180.0);
        bool byLat = spanLat >= spanLon;
        quickSort(s, 0, static_cast<long>(s.size()) - 1, [&](int a, int b) {
            return byLat ? T_[a].lat < T_[b].lat : T_[a].lon < T_[b].lon;
        });
    }

    // Divide and Conquer: if the towns fit one truck, stop. Otherwise sort them along the map, cut the line so
    // the first part holds about its share of the waste (floor(trucks/2) of the trucks needed), and solve both parts.
    void divide(std::vector<int> set, const std::vector<double>& q, double cap, std::vector<std::vector<int>>& out) const {
        double total = loadOf(set, q);
        if (set.size() <= 1 || total <= cap + 1e-9) { out.push_back(set); return; }
        sortAlongLongerAxis(set);
        int need = static_cast<int>(std::ceil(total / cap - 1e-9));
        double target = total * std::max(1, need / 2) / need, run = 0;
        size_t cut = 1;
        for (size_t k = 0; k < set.size(); ++k) {
            run += q[set[k]];
            cut = k + 1;
            if (run >= target - 1e-9) break;
        }
        cut = std::min(cut, set.size() - 1);
        divide(std::vector<int>(set.begin(), set.begin() + cut), q, cap, out);
        divide(std::vector<int>(set.begin() + cut, set.end()), q, cap, out);
    }

    // ---------- Branch and Bound: the best order for one truck (Travelling Salesperson) ----------
    // Reduced cost matrix bound: subtract the smallest value from every row and column; the sum subtracted is a
    // lower bound on any tour. The search tree grows one town at a time; a node is dropped as soon as its bound
    // is no better than the best tour found so far.
    struct BBNode {
        std::vector<double> m;
        std::vector<int> path;
        double cost;
        int cur;
        unsigned mask;
    };

    static double reduceMatrix(std::vector<double>& m, int n) {
        double red = 0;
        for (int r = 0; r < n; ++r) {
            double mn = INF;
            for (int c = 0; c < n; ++c) mn = std::min(mn, m[r * n + c]);
            if (mn > 0 && mn < INF) { for (int c = 0; c < n; ++c) if (m[r * n + c] < INF) m[r * n + c] -= mn; red += mn; }
        }
        for (int c = 0; c < n; ++c) {
            double mn = INF;
            for (int r = 0; r < n; ++r) mn = std::min(mn, m[r * n + c]);
            if (mn > 0 && mn < INF) { for (int r = 0; r < n; ++r) if (m[r * n + c] < INF) m[r * n + c] -= mn; red += mn; }
        }
        return red;
    }

    // Prim's minimum spanning tree over the points, then a preorder walk of the tree: a valid tour that is at most
    // twice the optimum. It is the first "best tour so far", so the search can prune from the very start.
    std::vector<int> mstWalk(const std::vector<int>& pts) const {
        size_t n = pts.size();
        std::vector<double> key(n, INF);
        std::vector<int> par(n, -1);
        std::vector<bool> in(n, false);
        key[0] = 0;
        for (size_t it = 0; it < n; ++it) {
            int u = -1;
            for (size_t v = 0; v < n; ++v) if (!in[v] && (u < 0 || key[v] < key[u])) u = static_cast<int>(v);
            in[u] = true;
            for (size_t v = 0; v < n; ++v)
                if (!in[v] && D_[pts[u]][pts[v]] < key[v]) { key[v] = D_[pts[u]][pts[v]]; par[v] = u; }
        }
        std::vector<std::vector<int>> kids(n);
        for (size_t v = 1; v < n; ++v) kids[par[v]].push_back(static_cast<int>(v));
        std::vector<int> order, stack{0};
        while (!stack.empty()) {
            int u = stack.back();
            stack.pop_back();
            order.push_back(u);
            for (size_t k = kids[u].size(); k-- > 0;) stack.push_back(kids[u][k]);
        }
        return order;
    }

    // strategy 0 = FIFO (queue), 1 = LIFO (stack), 2 = LC (always expand the node with the smallest bound).
    // All three find the same shortest tour; they differ in how many nodes they have to look at.
    std::vector<int> bbTour(const std::vector<int>& stops, int strategy, long& nodes, bool& capped) const {
        int k = static_cast<int>(stops.size());
        if (k <= 1) return stops;
        int n = k + 1;
        std::vector<int> pts{0};
        pts.insert(pts.end(), stops.begin(), stops.end());
        std::vector<double> base(n * n, INF);
        for (int i = 0; i < n; ++i)
            for (int j = 0; j < n; ++j) if (i != j) base[i * n + j] = D_[pts[i]][pts[j]];
        auto tourLen = [&](const std::vector<int>& p) {
            double d = 0;
            for (size_t i = 0; i + 1 < p.size(); ++i) d += base[p[i] * n + p[i + 1]];
            return d + base[p.back() * n];
        };
        std::vector<int> bestPath = mstWalk(pts);
        double best = tourLen(bestPath);

        BBNode root{base, {0}, 0, 0, 1u};
        root.cost = reduceMatrix(root.m, n);
        std::deque<BBNode> dq;
        auto cmp = [](const BBNode& a, const BBNode& b) { return a.cost > b.cost || (a.cost == b.cost && a.path.size() < b.path.size()); };
        std::priority_queue<BBNode, std::vector<BBNode>, decltype(cmp)> heap(cmp);
        auto push = [&](BBNode&& nd) { if (strategy == 2) heap.push(std::move(nd)); else dq.push_back(std::move(nd)); };
        auto empty = [&]() { return strategy == 2 ? heap.empty() : dq.empty(); };
        auto pop = [&]() {
            BBNode nd;
            if (strategy == 2) { nd = heap.top(); heap.pop(); }
            else if (strategy == 0) { nd = std::move(dq.front()); dq.pop_front(); }
            else { nd = std::move(dq.back()); dq.pop_back(); }
            return nd;
        };
        push(std::move(root));
        long mine = 0;
        while (!empty()) {
            BBNode nd = pop();
            if (nd.cost >= best - 1e-9) continue;
            size_t live = strategy == 2 ? heap.size() : dq.size();
            if (++mine > BB_MAX_NODES || live > 20000) { capped = true; break; }
            for (int j = 1; j < n; ++j) {
                if (nd.mask & (1u << j)) continue;
                BBNode ch;
                ch.m = nd.m;
                ch.cost = nd.cost + nd.m[nd.cur * n + j];
                for (int t = 0; t < n; ++t) { ch.m[nd.cur * n + t] = INF; ch.m[t * n + j] = INF; }
                ch.m[j * n] = INF;
                ch.cost += reduceMatrix(ch.m, n);
                ch.path = nd.path;
                ch.path.push_back(j);
                ch.cur = j;
                ch.mask = nd.mask | (1u << j);
                if (static_cast<int>(ch.path.size()) == n) {
                    double len = tourLen(ch.path);
                    if (len < best - 1e-9) { best = len; bestPath = ch.path; }
                } else if (ch.cost < best - 1e-9) {
                    push(std::move(ch));
                }
            }
        }
        nodes += mine;
        std::vector<int> order;
        for (size_t i = 1; i < bestPath.size(); ++i) order.push_back(pts[bestPath[i]]);
        return order;
    }

    // Groups from Divide and Conquer or Greedy, then the shortest order for each truck by Branch and Bound.
    Routes buildRoutes(const AlgoDef& a, const std::vector<int>& ids, const std::vector<double>& q, const Params& P,
                       long& nodes, bool& capped) const {
        std::vector<std::vector<int>> groups;
        if (a.divide) divide(ids, q, P.cap, groups); else groups = greedyGroups(ids, q, P.cap);
        Routes rs;
        for (const auto& g : groups) rs.push_back(bbTour(g, a.strategy, nodes, capped));
        if (P.balance) {  // Divide and Conquer again: split any route that is longer than the shift
            bool changed = true;
            while (changed) {
                changed = false;
                for (size_t k = 0; k < rs.size(); ++k) {
                    if (rs[k].size() < 2 || routeHours(rs[k]) <= P.shift + 1e-9) continue;
                    std::vector<int> g = rs[k];
                    sortAlongLongerAxis(g);
                    size_t h = g.size() / 2;
                    rs[k] = bbTour(std::vector<int>(g.begin(), g.begin() + h), a.strategy, nodes, capped);
                    rs.push_back(bbTour(std::vector<int>(g.begin() + h, g.end()), a.strategy, nodes, capped));
                    changed = true;
                    break;
                }
            }
        }
        return rs;
    }

    void initAlgos() {
        algos_ = {
            {"dc-lc", "Divide & Conquer + B&B (LC)", true, 2},
            {"gk-lc", "Greedy Kruskal + B&B (LC)", false, 2},
            {"gk-fifo", "Greedy Kruskal + B&B (FIFO)", false, 0},
            {"gk-lifo", "Greedy Kruskal + B&B (LIFO)", false, 1},
        };
    }

    // ---------- small helpers ----------
    double routeHours(const std::vector<int>& r) const {
        return r.empty() ? 0.0 : routeKm(r) / SPEED_KMH + r.size() * STOP_MIN / 60.0;
    }
    static double loadOf(const std::vector<int>& r, const std::vector<double>& q) {
        double s = 0;
        for (int n : r) s += q[n];
        return s;
    }

    // ---------- lower bound (MST) ----------
    // Any set of closed tours through the yard connects yard + served towns, so its length
    // can never be below the minimum spanning tree of those points (Prim, O(n^2)).
    double mstBound(const std::vector<int>& served) const {
        if (served.empty()) return 0;
        std::vector<int> pts{0};
        pts.insert(pts.end(), served.begin(), served.end());
        size_t n = pts.size();
        std::vector<double> key(n, INF);
        std::vector<bool> in(n, false);
        key[0] = 0;
        double total = 0;
        for (size_t it = 0; it < n; ++it) {
            int u = -1;
            for (size_t v = 0; v < n; ++v) if (!in[v] && (u < 0 || key[v] < key[u])) u = static_cast<int>(v);
            in[u] = true;
            total += key[u];
            for (size_t v = 0; v < n; ++v) if (!in[v] && D_[pts[u]][pts[v]] < key[v]) key[v] = D_[pts[u]][pts[v]];
        }
        return total;
    }

    // ---------- 0/1 knapsack (dynamic programming) ----------
    // If the towns together hold more waste than the whole fleet can carry (trucks x capacity), keep the set of
    // towns with the greatest total urgency whose waste still fits. Urgency = fill %, and critical (red) towns
    // count for far more, so they are the last to be left out.
    void knapsackSelect(const std::vector<int>& ids, const std::vector<double>& q, const std::vector<int>& fills,
                        const Params& P, std::vector<int>& keep, std::vector<Unserved>& dropped) const {
        keep = ids;
        double total = loadOf(ids, q), fleetCap = P.fleet * P.cap;
        if (total <= fleetCap + 1e-9) return;
        const int U = 10;  // weights in 0.1 t units
        int W = static_cast<int>(std::floor(fleetCap * U + 1e-9));
        size_t n = ids.size();
        std::vector<int> w(n);
        std::vector<long> v(n);
        for (size_t i = 0; i < n; ++i) {
            w[i] = std::max(1, static_cast<int>(std::ceil(q[ids[i]] * U - 1e-9)));
            v[i] = fills[ids[i]] + (fills[ids[i]] >= P.crit ? 1000 : 0);
        }
        std::vector<std::vector<long>> best(n + 1, std::vector<long>(W + 1, 0));
        for (size_t i = 1; i <= n; ++i)
            for (int c = 0; c <= W; ++c) {
                best[i][c] = best[i - 1][c];
                if (w[i - 1] <= c) best[i][c] = std::max(best[i][c], best[i - 1][c - w[i - 1]] + v[i - 1]);
            }
        keep.clear();
        int c = W;
        for (size_t i = n; i >= 1; --i) {
            if (best[i][c] != best[i - 1][c]) { keep.push_back(ids[i - 1]); c -= w[i - 1]; }
            else dropped.push_back({ids[i - 1], "fleet capacity: " + std::to_string(P.fleet) + " trucks x " + fmt(P.cap, 0) +
                                                " t cannot carry everything, the knapsack kept the most urgent towns"});
        }
        std::reverse(keep.begin(), keep.end());
    }

    // ---------- solving one day with one algorithm ----------
    // Oversized towns cannot be served at all. If the fleet cannot carry everything, the 0/1 knapsack picks the
    // towns to keep. If the groups still need more trucks than the depot owns (packing is never perfect), the least
    // urgent town is dropped and the whole thing is solved again.
    Outcome solve(const AlgoDef& a, std::vector<int> ids, const std::vector<double>& q,
                  const std::vector<int>& fills, const Params& P, int reps) const {
        auto t0 = std::chrono::steady_clock::now();
        Outcome o;
        std::vector<int> fit;
        for (int id : ids) {
            if (q[id] > P.cap + 1e-9)
                o.unserved.push_back({id, "holds " + fmt(q[id], 1) + " t, more than one truck carries (" + fmt(P.cap, 0) + " t)"});
            else
                fit.push_back(id);
        }
        const size_t oversize = o.unserved.size();
        std::vector<int> chosen;
        std::vector<Unserved> knapDropped;
        knapsackSelect(fit, q, fills, P, chosen, knapDropped);
        int done = 0;
        for (int rep = 0; rep < reps; ++rep) {
            ++done;
            o.unserved.erase(o.unserved.begin() + static_cast<long>(oversize), o.unserved.end());
            std::vector<int> work = chosen;
            std::vector<Unserved> dropped;
            Routes rs;
            long nodes = 0;
            bool capped = false;
            for (;;) {
                nodes = 0; capped = false;
                rs = work.empty() ? Routes{} : buildRoutes(a, work, q, P, nodes, capped);
                if (static_cast<int>(rs.size()) <= P.fleet || work.empty()) break;
                size_t worstAt = 0;
                for (size_t k = 1; k < work.size(); ++k) {
                    int x = work[k], y = work[worstAt];
                    if (fills[x] < fills[y] || (fills[x] == fills[y] && D_[0][x] > D_[0][y])) worstAt = k;
                }
                dropped.push_back({work[worstAt], "fleet limit: " + std::to_string(P.fleet) + " trucks cannot cover every town"});
                work.erase(work.begin() + worstAt);
            }
            o.routes = rs;
            o.nodes = nodes;
            o.capped = capped;
            for (const Unserved& u : knapDropped) o.unserved.push_back(u);
            for (const Unserved& u : dropped) o.unserved.push_back(u);
            double so_far = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
            if (so_far > 15.0) break;  // slow case: one run is enough to time it
        }
        o.execMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / done;
        return o;
    }

    // ---------- numbers worked out from routes ----------
    Stats stats(const Routes& routes, const std::vector<double>& q) const {
        Stats s;
        int stops = 0;
        for (const auto& r : routes) {
            Row row;
            row.nodes = r;
            row.km = routeKm(r);
            for (int n : r) row.load += q[n];
            row.hours = row.km / SPEED_KMH + r.size() * STOP_MIN / 60.0;
            // timeline: yard -> each stop -> yard, minutes after the 06:00 departure
            double t = 0, km = 0, onBoard = 0;
            int cur = 0;
            for (int n : r) {
                km += D_[cur][n];
                t += D_[cur][n] / SPEED_KMH * 60.0;
                onBoard += q[n];
                row.stops.push_back({n, t, t + STOP_MIN, km, onBoard});
                t += STOP_MIN;
                cur = n;
            }
            row.returnMin = t + D_[cur][0] / SPEED_KMH * 60.0;
            s.km += row.km;
            s.makespan = std::max(s.makespan, row.hours);
            stops += static_cast<int>(r.size());
            s.rows.push_back(row);
        }
        s.trucks = static_cast<int>(routes.size());
        s.hours = s.km / SPEED_KMH + stops * STOP_MIN / 60.0;
        return s;
    }

    struct Day {
        std::vector<int> fills, ids;
        std::vector<double> q;
        std::vector<Res> res;
        size_t chosen = 0;
    };

    int tierOf(int fill, const Params& P) const { return fill >= P.crit ? 2 : fill >= P.warn ? 1 : 0; }

    // Run all algorithms for the given parameters and work out every metric.
    Day compute(const Params& P) const {
        if (P.seed < 1 || P.seed > 1000000) throw std::invalid_argument("seed must be 1..1000000");
        if (P.thr < 0 || P.thr > 100) throw std::invalid_argument("thr must be 0..100");
        if (!(P.cap >= 1.0 && P.cap <= 100.0)) throw std::invalid_argument("cap must be 1..100");
        if (P.crit < 1 || P.crit > 100) throw std::invalid_argument("crit must be 1..100");
        if (P.warn < 0 || P.warn > P.crit) throw std::invalid_argument("warn must be 0..crit");
        if (P.fleet < 1 || P.fleet > 20) throw std::invalid_argument("fleet must be 1..20");
        if (!(P.shift >= 1.0 && P.shift <= 24.0)) throw std::invalid_argument("shift must be 1..24");
        Day d;
        d.chosen = algos_.size();
        for (size_t k = 0; k < algos_.size(); ++k) if (algos_[k].id == P.algo) d.chosen = k;
        if (d.chosen == algos_.size()) throw std::invalid_argument("unknown algo '" + P.algo + "'");

        d.fills = fillsFor(P.seed);
        d.q.assign(N_, 0.0);
        for (int i = 1; i < N_; ++i) {
            d.q[i] = T_[i].capT() * d.fills[i] / 100.0;
            // collect when at least the cut-off full; critical (red) bins are always collected
            if (d.fills[i] >= P.thr || d.fills[i] >= P.crit) d.ids.push_back(i);
        }
        for (const AlgoDef& a : algos_) {
            Res r;
            r.id = a.id;
            r.name = a.name;
            r.out = solve(a, d.ids, d.q, d.fills, P, REPS);
            r.st = stats(r.out.routes, d.q);
            std::vector<int> served;
            for (const Row& row : r.st.rows) {
                if (row.load > P.cap + 1e-9) ++r.capViol;
                if (row.hours > P.shift + 1e-9) ++r.shiftViol;
                for (int n : row.nodes) served.push_back(n);
            }
            r.served = static_cast<int>(served.size());
            for (int n : served) r.directKm += 2 * D_[0][n];
            r.lowerBound = mstBound(served);
            r.fuelL = r.st.km * FUEL_L_PER_KM;
            r.cost = r.fuelL * DIESEL_INR_PER_L;
            r.co2 = r.fuelL * CO2_KG_PER_L;
            double load = 0;
            for (size_t k = 0; k < r.st.rows.size(); ++k) {
                load += r.st.rows[k].load;
                if (r.longestTruck < 0 || r.st.rows[k].km > r.st.rows[r.longestTruck].km) r.longestTruck = static_cast<int>(k);
            }
            r.util = r.st.trucks ? load / (r.st.trucks * P.cap) * 100.0 : 0;
            if (r.st.trucks) {
                r.imbalance = r.st.makespan / (r.st.hours / r.st.trucks);
                r.longestShare = r.st.km > 0 ? r.st.rows[r.longestTruck].km / r.st.km * 100.0 : 0;
            }
            d.res.push_back(std::move(r));
        }
        return d;
    }

    static int indexOf(const Day& d, const std::string& id) {
        for (size_t k = 0; k < d.res.size(); ++k) if (d.res[k].id == id) return static_cast<int>(k);
        return 0;
    }

    // ---------- JSON ----------
    static double rnd(double x, int dec) {
        double p = std::pow(10.0, dec);
        return std::round(x * p) / p;
    }
    static std::string fmt(double x, int dec) {
        char buf[64];
        std::snprintf(buf, sizeof buf, "%.*f", dec, x);
        return buf;
    }
    static std::string hhmm(double minAfterStart) {
        int m = static_cast<int>(std::lround(START_MIN + minAfterStart));
        char buf[16];
        std::snprintf(buf, sizeof buf, "%02d:%02d", (m / 60) % 24, m % 60);
        return buf;
    }

    json resJson(const Day& d, const Res& r) const {
        json rows = json::array();
        for (const Row& row : r.st.rows) {
            json stops = json::array();
            for (const Stop& s : row.stops)
                stops.push_back({{"id", s.id}, {"arr", rnd(s.arr, 2)}, {"dep", rnd(s.dep, 2)},
                                 {"km", rnd(s.km, 2)}, {"loadAfter", rnd(s.loadAfter, 3)}});
            double fuel = row.km * FUEL_L_PER_KM;
            rows.push_back({{"nodes", row.nodes}, {"path", fullPath(row.nodes)}, {"stops", stops},
                            {"km", rnd(row.km, 2)}, {"load", rnd(row.load, 3)}, {"hours", rnd(row.hours, 3)},
                            {"returnMin", rnd(row.returnMin, 2)}, {"fuelL", rnd(fuel, 2)},
                            {"fuelCost", rnd(fuel * DIESEL_INR_PER_L, 0)}, {"co2Kg", rnd(fuel * CO2_KG_PER_L, 2)}});
        }
        json uns = json::array();
        for (const Unserved& u : r.out.unserved)
            uns.push_back({{"id", u.id}, {"reason", u.reason}, {"fill", d.fills[u.id]}});
        double saved = r.directKm - r.st.km;
        double worstKm = 0;  // longest plan among the methods that serve the same number of towns
        for (const Res& o : d.res) if (o.served == r.served) worstKm = std::max(worstKm, o.st.km);
        json vsWorst = worstKm > 0 ? json(rnd((worstKm - r.st.km) / worstKm * 100.0, 2)) : json(nullptr);
        json gap = nullptr;
        if (r.lowerBound > 0) gap = rnd((r.st.km - r.lowerBound) / r.lowerBound * 100.0, 1);
        return {{"id", r.id}, {"name", r.name}, {"trucks", r.st.trucks}, {"km", rnd(r.st.km, 2)},
                {"hours", rnd(r.st.hours, 3)}, {"makespan", rnd(r.st.makespan, 3)}, {"served", r.served},
                {"unserved", uns}, {"capViolations", r.capViol}, {"shiftViolations", r.shiftViol},
                {"fuelL", rnd(r.fuelL, 2)}, {"fuelCost", rnd(r.cost, 0)}, {"co2Kg", rnd(r.co2, 2)},
                {"util", rnd(r.util, 1)}, {"imbalance", rnd(r.imbalance, 2)}, {"longestShare", rnd(r.longestShare, 1)},
                {"longestTruck", r.longestTruck}, {"directKm", rnd(r.directKm, 2)}, {"savedKm", rnd(saved, 2)},
                {"savedPct", r.directKm > 0 ? rnd(saved / r.directKm * 100.0, 1) : 0.0},
                {"savedFuelL", rnd(saved * FUEL_L_PER_KM, 2)}, {"savedCost", rnd(saved * FUEL_L_PER_KM * DIESEL_INR_PER_L, 0)},
                {"co2AvoidedKg", rnd(saved * FUEL_L_PER_KM * CO2_KG_PER_L, 2)},
                {"lowerBoundKm", rnd(r.lowerBound, 2)}, {"gapPct", gap}, {"execMs", rnd(r.out.execMs, 4)},
                {"vsWorstPct", vsWorst}, {"bbNodes", r.out.nodes}, {"bbCapped", r.out.capped}, {"rows", rows}};
    }

    // Rank: most towns served, fewest capacity violations, fewest overtime routes, then shortest distance,
    // then fewest trucks, then fewest Branch and Bound nodes; a full tie goes to the earlier method.
    // Every reason given is read straight from the numbers.
    json winnerJson(const Day& d) const {
        auto better = [](const Res& a, const Res& b) {  // is a better than b?
            if (a.served != b.served) return a.served > b.served;
            if (a.capViol != b.capViol) return a.capViol < b.capViol;
            if (a.shiftViol != b.shiftViol) return a.shiftViol < b.shiftViol;
            if (std::fabs(a.st.km - b.st.km) > 0.05) return a.st.km < b.st.km;
            if (a.st.trucks != b.st.trucks) return a.st.trucks < b.st.trucks;
            return a.out.nodes < b.out.nodes;
        };
        size_t w = 0;
        for (size_t k = 1; k < d.res.size(); ++k) if (better(d.res[k], d.res[w])) w = k;
        const Res& win = d.res[w];
        json reasons = json::array();
        if (win.served == 0) {
            reasons.push_back("No town is on today's run, so there is nothing to compare.");
            return {{"id", win.id}, {"name", win.name}, {"reasons", reasons}};
        }
        const Res* worst = nullptr;
        for (const Res& r : d.res) if (&r != &win && r.served == win.served && (!worst || r.st.km > worst->st.km)) worst = &r;
        const Res* shortest = &win;
        for (const Res& r : d.res) if (r.st.km < shortest->st.km - 0.05) shortest = &r;
        if (shortest != &win) {
            std::string why = shortest->served < win.served ? "serves fewer towns"
                              : shortest->capViol > win.capViol ? "overloads a truck"
                                                                : "has " + std::to_string(shortest->shiftViol) + " route(s) past the shift limit";
            reasons.push_back(shortest->name + " is shorter (" + fmt(shortest->st.km, 1) + " km) but " + why + ", so " + win.name +
                              " (" + fmt(win.st.km, 1) + " km) is the best plan that respects every limit.");
        } else if (worst && worst->st.km > win.st.km + 0.05)
            reasons.push_back("Shortest total distance: " + fmt(win.st.km, 1) + " km, which is " +
                              fmt((worst->st.km - win.st.km) / worst->st.km * 100.0, 1) + "% (" +
                              fmt(worst->st.km - win.st.km, 1) + " km) less than " + worst->name + " (" + fmt(worst->st.km, 1) + " km).");
        else
            reasons.push_back("Total distance is " + fmt(win.st.km, 1) + " km, the same as every other method that serves all the towns.");
        for (const Res& r : d.res)
            if (&r != &win && r.served == win.served && r.st.trucks == win.st.trucks && std::fabs(r.st.km - win.st.km) <= 0.05 &&
                r.id.substr(0, 2) == win.id.substr(0, 2) && r.out.nodes != win.out.nodes)
                reasons.push_back(r.name + " reaches the same distance but examines " + std::to_string(r.out.nodes) + " Branch-and-Bound nodes against " +
                                  std::to_string(win.out.nodes) + ". The search order changes the work, not the answer.");
        const Res* moreTrucks = nullptr;
        for (const Res& r : d.res) if (&r != &win && r.st.trucks > win.st.trucks && r.served == win.served) moreTrucks = &r;
        if (moreTrucks)
            reasons.push_back("It needs " + std::to_string(win.st.trucks) + " trucks where " + moreTrucks->name + " needs " +
                              std::to_string(moreTrucks->st.trucks) + ".");
        if (win.capViol == 0 && win.shiftViol == 0)
            reasons.push_back("No truck is overloaded and no route runs past the shift limit.");
        else if (win.capViol == 0)
            reasons.push_back("No truck is overloaded, but " + std::to_string(win.shiftViol) + " route(s) run past the shift limit; try Balance workload.");
        reasons.push_back(win.id.substr(0, 2) == "dc"
            ? "Divide and Conquer cuts the towns by map position until each part fits one truck, so every truck stays in its own area."
            : "Greedy Kruskal grouping joins the closest towns first while the load still fits the truck, so neighbouring towns share a truck.");
        reasons.push_back("Branch and Bound then finds the shortest order for each truck's towns" +
                          std::string(win.out.capped ? ", but it hit its node limit on a large route, so that route may be slightly longer than the best possible." : "."));
        return {{"id", win.id}, {"name", win.name}, {"reasons", reasons}};
    }

    // Problems a planner should see before accepting the plan.
    json warningsFor(const Day& d, const Res& r, const Params& P) const {
        json w = json::array();
        auto add = [&w](const char* level, const char* code, const std::string& msg, int town, int truck) {
            json j = {{"level", level}, {"code", code}, {"msg", msg}};
            if (town >= 0) j["town"] = town;
            if (truck >= 0) j["truck"] = truck;
            w.push_back(j);
        };
        for (int i = 1; i < N_; ++i)
            if (std::isinf(D_[0][i])) add("error", "unreachable", T_[i].name + " has no road link to the yard in the network.", i, -1);
        for (const Unserved& u : r.out.unserved) {
            bool red = d.fills[u.id] >= P.crit;
            add(red ? "error" : "warn", red ? "critical-unserved" : "unserved",
                T_[u.id].name + " (" + std::to_string(d.fills[u.id]) + "% full) is not served (" + u.reason + ").", u.id, -1);
        }
        for (size_t k = 0; k < r.st.rows.size(); ++k) {
            const Row& row = r.st.rows[k];
            if (row.hours > P.shift + 1e-9)
                add("warn", "overtime", "Truck " + std::to_string(k + 1) + " works " + fmt(row.hours, 1) + " h, over the " +
                    fmt(P.shift, 0) + " h shift limit.", -1, static_cast<int>(k));
            if (row.load > P.cap + 1e-9)
                add("error", "overload", "Truck " + std::to_string(k + 1) + " carries " + fmt(row.load, 1) + " t, over its " +
                    fmt(P.cap, 0) + " t capacity.", -1, static_cast<int>(k));
        }
        if (r.st.trucks >= 2 && r.longestShare > 55.0)
            add(P.balance ? "info" : "warn", "imbalance",
                "Truck " + std::to_string(r.longestTruck + 1) + " drives " + fmt(r.longestShare, 0) + "% of the total distance (" +
                fmt(r.st.rows[r.longestTruck].hours, 1) + " h against an average of " + fmt(r.st.hours / r.st.trucks, 1) + " h)." +
                (P.balance ? " Balancing is on; this is the best split found." : " Switch on Balance workload to see if it can be shared out."),
                -1, r.longestTruck);
        if (r.out.capped)
            add("info", "bb-capped", "Branch and Bound reached its node limit on a large route, so that route's order may not be the shortest possible.", -1, -1);
        if (r.st.trucks >= 2 && r.util < 45.0)
            add("info", "low-utilisation", "Trucks are only " + fmt(r.util, 0) + "% full on average; fewer or smaller trucks might do.", -1, -1);
        return w;
    }

    // ---------- daily fill levels ----------
    std::vector<int> fillsFor(int seed) const {
        Mulberry rnd(static_cast<uint32_t>(seed) * 7919u + 13u);
        std::vector<int> f(N_, 0);
        for (int i = 0; i < N_; ++i)
            f[i] = T_[i].depot ? 0 : static_cast<int>(std::floor(15 + rnd.next() * 80 + 0.5));
        return f;
    }
};

}  // namespace waste
