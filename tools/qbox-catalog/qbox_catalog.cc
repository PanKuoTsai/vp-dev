/*
 * qbox-catalog: list the module types a QBox build provides and introspect
 * each one (sockets, signal ports, CCI parameters), writing one JSON catalog.
 *
 * Modes
 *   qbox-catalog --qbox-src DIR --libdir DIR --out FILE [--jobs N] [--only T,T]
 *       Driver. Scans QBox sources for module registrations and constructor
 *       argument kinds, loads every module library in --libdir, then runs
 *       itself once per module type in --introspect mode and merges results.
 *   qbox-catalog --introspect TYPE --plan FILE --out FILE
 *       Child. Builds a container holding TYPE (named "dut") plus the modules
 *       its constructor needs, then dumps the dut's sockets and parameters.
 *       Nothing is elaborated or simulated, so QEMU is never initialised.
 *
 * Every module is introspected in its own process: a constructor that aborts
 * only loses that one entry.
 */

#include <systemc>
#include <tlm>
#include <cci_configuration>

#include <cciutils.h>
#include <module_factory_container.h>

#include <cxxabi.h>
#include <dirent.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

const char* const FACTORY_PREFIX = CCI_GS_MF_NAME; // "__GS.ModuleFactory."
const char* const TOOL_VERSION = "0.1";

/* ---------------------------------------------------------------- utils */

std::string json_str(const std::string& s)
{
    std::string o = "\"";
    for (unsigned char c : s) {
        switch (c) {
        case '"':
            o += "\\\"";
            break;
        case '\\':
            o += "\\\\";
            break;
        case '\n':
            o += "\\n";
            break;
        case '\r':
            o += "\\r";
            break;
        case '\t':
            o += "\\t";
            break;
        default:
            if (c < 0x20) {
                char b[8];
                snprintf(b, sizeof b, "\\u%04x", c);
                o += b;
            } else {
                o += static_cast<char>(c);
            }
        }
    }
    return o + "\"";
}

std::string demangle(const char* n)
{
    int st = 0;
    std::unique_ptr<char, void (*)(void*)> r(abi::__cxa_demangle(n, nullptr, nullptr, &st), std::free);
    return st == 0 && r ? std::string(r.get()) : std::string(n);
}

std::string read_file(const std::string& p)
{
    std::ifstream f(p, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

bool ends_with(const std::string& s, const std::string& suf)
{
    return s.size() >= suf.size() && s.compare(s.size() - suf.size(), suf.size(), suf) == 0;
}

std::string trim(std::string s)
{
    size_t a = s.find_first_not_of(" \t\r\n");
    size_t b = s.find_last_not_of(" \t\r\n");
    return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}

std::vector<std::string> split(const std::string& s, char sep)
{
    std::vector<std::string> out;
    std::string cur;
    for (char c : s) {
        if (c == sep) {
            out.push_back(cur);
            cur.clear();
        } else {
            cur += c;
        }
    }
    out.push_back(cur);
    return out;
}

void walk_dir(const std::string& dir, const std::function<void(const std::string&)>& fn)
{
    DIR* d = opendir(dir.c_str());
    if (!d) return;
    while (dirent* e = readdir(d)) {
        std::string n = e->d_name;
        if (n == "." || n == ".." || n == ".git" || n == "build" || n == "_deps") continue;
        std::string p = dir + "/" + n;
        struct stat st;
        if (stat(p.c_str(), &st) != 0) continue;
        if (S_ISDIR(st.st_mode))
            walk_dir(p, fn);
        else if (S_ISREG(st.st_mode))
            fn(p);
    }
    closedir(d);
}

std::string run_capture(const std::string& cmd)
{
    std::string out;
    if (FILE* p = popen(cmd.c_str(), "r")) {
        char buf[256];
        while (fgets(buf, sizeof buf, p)) out += buf;
        pclose(p);
    }
    return trim(out);
}

/* ------------------------------------------------- source scan (driver) */

/*
 * One constructor argument as declared in GSC_MODULE_REGISTER. For
 * sc_object* arguments, "cls" is the class the constructor dynamic_casts it
 * to (QemuInstance, qemu_gpex, ...), taken in order of appearance.
 */
struct ArgSpec {
    std::string decl; // as written, e.g. "sc_core::sc_object*"
    std::string kind; // object | integer | bool | string | unknown
    std::string cls;  // for kind == object, when known
};

struct Registration {
    std::string type;
    std::string source; // relative path of the registering file
    std::vector<ArgSpec> args;
};

std::string strip_comments(const std::string& s)
{
    static const std::regex block(R"(/\*[\s\S]*?\*/)");
    static const std::regex line(R"(//[^\n]*)");
    return std::regex_replace(std::regex_replace(s, block, " "), line, " ");
}

std::string arg_kind(const std::string& decl)
{
    if (decl.find("sc_object") != std::string::npos && decl.find('*') != std::string::npos) return "object";
    if (decl == "bool") return "bool";
    if (decl.find("string") != std::string::npos || decl.find("char") != std::string::npos) return "string";
    static const std::regex integer(R"(^(unsigned\s+)?(u?int(8|16|32|64)_t|int|long|unsigned|size_t)$)");
    if (std::regex_match(decl, integer)) return "integer";
    return "unknown";
}

/* "const qemu_gpex* gpex = nullptr" -> "qemu_gpex"; "smmuv3<BUSWIDTH>* s" -> "smmuv3" */
std::string param_class(std::string p)
{
    size_t eq = p.find('=');
    if (eq != std::string::npos) p = p.substr(0, eq);
    static const std::regex tmpl(R"(<[^<>]*>)");
    while (std::regex_search(p, tmpl)) p = std::regex_replace(p, tmpl, "");
    static const std::regex id(R"([A-Za-z_][\w:]*)");
    std::vector<std::string> ids;
    for (std::sregex_iterator it(p.begin(), p.end(), id), e; it != e; ++it)
        if ((*it)[0] != "const" && (*it)[0] != "struct" && (*it)[0] != "class") ids.push_back((*it)[0]);
    if (ids.empty()) return "";
    // The last identifier is the parameter name when there are two or more.
    std::string t = ids.size() >= 2 ? ids[ids.size() - 2] : ids.back();
    size_t colon = t.rfind("::");
    return colon == std::string::npos ? t : t.substr(colon + 2);
}

/* Split a parameter list on top-level commas. */
std::vector<std::string> split_params(const std::string& s)
{
    std::vector<std::string> out;
    std::string cur;
    int depth = 0;
    for (char c : s) {
        if (c == '<' || c == '(') depth++;
        if (c == '>' || c == ')') depth--;
        if (c == ',' && depth == 0) {
            out.push_back(trim(cur));
            cur.clear();
        } else {
            cur += c;
        }
    }
    if (!trim(cur).empty()) out.push_back(trim(cur));
    return out;
}

/*
 * Work out which class each sc_object* argument must be. Two sources, in
 * order of preference:
 *  1. a typed constructor overload of the same arity, e.g.
 *     virtio_gpu_gl_pci(name, QemuInstance& inst, qemu_gpex* gpex), which the
 *     sc_object* constructor delegates to, position for position;
 *  2. the dynamic_casts in a constructor definition, in order of appearance.
 */
void resolve_object_args(const std::string& name, Registration& r, const std::map<std::string, std::string>& files)
{
    size_t nobj = std::count_if(r.args.begin(), r.args.end(), [](const ArgSpec& a) { return a.kind == "object"; });
    if (!nobj) return;

    const std::regex ctor("(?:^|[^\\w:~])(?:" + name + "::)?" + name +
                          R"(\s*\(\s*((?:const\s+)?(?:sc_core::)?sc_module_name[^()]*)\))");
    std::vector<std::string> typed;      // classes from a typed overload
    std::vector<std::string> best_casts; // classes from dynamic_casts
    static const std::regex cast(R"(dynamic_cast\s*<\s*(?:const\s+)?([\w:]+)\s*(?:<[^<>]*>)?\s*\*\s*>)");
    for (auto& [path, text] : files) {
        for (std::sregex_iterator it(text.begin(), text.end(), ctor), e; it != e; ++it) {
            auto params = split_params((*it)[1]);
            if (params.size() == r.args.size() + 1 && typed.empty()) {
                bool all_typed = true;
                std::vector<std::string> cls;
                for (size_t i = 0; i < r.args.size(); i++) {
                    if (r.args[i].kind != "object") continue;
                    if (params[i + 1].find("sc_object") != std::string::npos) all_typed = false;
                    cls.push_back(param_class(params[i + 1]));
                }
                if (all_typed) typed = cls;
            }
            std::string window = text.substr(it->position(0), 2500);
            size_t endpos = window.find("\n    }\n");
            if (endpos != std::string::npos) window = window.substr(0, endpos);
            std::vector<std::string> classes;
            for (std::sregex_iterator ci(window.begin(), window.end(), cast), ce; ci != ce; ++ci) {
                std::string c = (*ci)[1];
                size_t colon = c.rfind("::");
                if (colon != std::string::npos) c = c.substr(colon + 2);
                if (std::find(classes.begin(), classes.end(), c) == classes.end()) classes.push_back(c);
            }
            if (classes.size() > best_casts.size() && classes.size() <= nobj) best_casts = classes;
        }
    }
    const std::vector<std::string>& use = !typed.empty() ? typed : best_casts;
    size_t k = 0;
    for (auto& a : r.args)
        if (a.kind == "object" && k < use.size()) a.cls = use[k++];
}

std::map<std::string, Registration> scan_sources(const std::string& root)
{
    std::map<std::string, std::string> files; // path -> comment-stripped text
    // QBox's source tree, or a model folder made by the VP Studio wizard (src, include).
    for (const char* sub : { "systemc-components", "qemu-components", "platforms", "src", "include" }) {
        walk_dir(root + "/" + sub, [&](const std::string& p) {
            if (!(ends_with(p, ".h") || ends_with(p, ".cc") || ends_with(p, ".cpp") || ends_with(p, ".hpp")))
                return;
            if (p.find("/tests/") != std::string::npos) return;
            std::string t = read_file(p);
            if (t.find("GSC_MODULE_REGISTER") == std::string::npos && t.find("sc_module_name") == std::string::npos)
                return;
            files[p] = strip_comments(t);
        });
    }

    std::map<std::string, Registration> regs;
    static const std::regex reg(R"(GSC_MODULE_REGISTER(?:_C)?\s*\(\s*(\w+)\s*((?:,[^;()]*)?)\))");
    for (auto& [path, text] : files) {
        for (std::sregex_iterator it(text.begin(), text.end(), reg), end; it != end; ++it) {
            std::string name = (*it)[1];
            if (name == "__NAME__") continue;
            Registration r;
            r.type = name;
            r.source = path.substr(root.size() + 1);
            std::string rest = (*it)[2];
            if (!rest.empty()) {
                for (auto& a : split(rest.substr(1), ',')) {
                    ArgSpec s;
                    s.decl = trim(a);
                    s.kind = arg_kind(s.decl);
                    r.args.push_back(s);
                }
            }
            regs.emplace(name, r); // first registration wins
        }
    }

    for (auto& [name, r] : regs) resolve_object_args(name, r, files);
    return regs;
}

/* ------------------------------------------------ library load (driver) */

struct TypeInfo {
    std::string type;
    std::string library; // file name, "" when built into the tool
    bool is_container = false;
};

/* Materialise header-registered constructors queued by static initialisers. */
void drain_static_registrations()
{
    auto mods = gs::ModuleFactory::GetAvailableModuleList();
    while (mods->size()) {
        try {
            (mods->back())();
        } catch (...) {
        }
        mods->pop_back();
    }
}

std::map<std::string, TypeInfo> registered_types(cci::cci_broker_handle& broker)
{
    std::map<std::string, TypeInfo> out;
    for (auto& h : broker.get_param_handles()) {
        std::string n = h.name();
        if (n.rfind(FACTORY_PREFIX, 0) != 0) continue;
        cci::cci_param_typed_handle<gs::cci_constructor_vl> f(h);
        if (!f.is_valid()) continue;
        TypeInfo t;
        t.type = (*f).type;
        t.is_container = (*f).is_container();
        out.emplace(t.type, t);
    }
    return out;
}

std::map<std::string, TypeInfo> load_all_libraries(const std::string& libdir, cci::cci_broker_handle& broker,
                                                   std::vector<std::pair<std::string, std::string>>& lib_errors)
{
    drain_static_registrations();
    std::map<std::string, TypeInfo> types = registered_types(broker);

    std::vector<std::string> libs;
    walk_dir(libdir, [&](const std::string& p) {
        if (ends_with(p, ".so") && p.find('/', libdir.size() + 1) == std::string::npos) libs.push_back(p);
    });
    std::sort(libs.begin(), libs.end());

    for (auto& p : libs) {
        std::string file = p.substr(libdir.size() + 1);
        void* h = dlopen(p.c_str(), RTLD_NOW | RTLD_GLOBAL);
        if (!h) {
            lib_errors.push_back({ file, dlerror() });
            continue;
        }
        auto reg = reinterpret_cast<void (*)()>(dlsym(h, "module_register"));
        if (!reg) continue; // a support library, not a module
        try {
            reg();
        } catch (const std::exception& e) {
            lib_errors.push_back({ file, e.what() });
        }
        drain_static_registrations();
        for (auto& [name, t] : registered_types(broker)) {
            if (types.count(name)) continue;
            t.library = file;
            types.emplace(name, t);
        }
    }
    return types;
}

/*
 * module_register() creates CCI parameters, which need a SystemC hierarchy as
 * originator. The container does this from its constructor; do the same.
 */
struct LibraryLoader : sc_core::sc_module {
    std::map<std::string, TypeInfo> types;
    LibraryLoader(const sc_core::sc_module_name& n, const std::string& libdir, cci::cci_broker_handle& broker,
                  std::vector<std::pair<std::string, std::string>>& lib_errors)
        : sc_core::sc_module(n)
    {
        types = load_all_libraries(libdir, broker, lib_errors);
    }
};

/* --------------------------------------------------------------- hints */

/*
 * hints.json supplies what the sources cannot: the class of an object argument
 * the scanner could not resolve, and parameters a constructor refuses to run
 * without. Format:
 *   { "classAliases": { "QemuVirtioGpu": "virtio_gpu_pci" },
 *     "modules": { "nvme": { "args": ["QemuInstance", "qemu_gpex"],
 *                            "params": { "blob_file": "/dev/null" },
 *                            "note": "..." } } }
 */
struct Hint {
    std::vector<std::string> args;                            // classes of the object arguments, in order
    std::vector<std::pair<std::string, std::string>> params; // name -> JSON value
    std::string note;
};

struct Hints {
    std::map<std::string, std::string> aliases;
    std::map<std::string, Hint> modules;
};

Hints load_hints(const std::string& path)
{
    Hints h;
    std::string text = read_file(path);
    if (trim(text).empty()) return h;
    cci::cci_value v = cci::cci_value::from_json(text);
    if (!v.is_map()) return h;
    auto root = v.get_map();
    if (root.has_entry("classAliases")) {
        auto a = root.at("classAliases").get_map();
        for (auto it = a.cbegin(); it != a.cend(); ++it)
            h.aliases[std::string(it->key)] = std::string(it->value.get_string());
    }
    if (root.has_entry("modules")) {
        auto mods = root.at("modules").get_map();
        for (auto it = mods.cbegin(); it != mods.cend(); ++it) {
            Hint hint;
            auto m = it->value.get_map();
            if (m.has_entry("args")) {
                auto l = m.at("args").get_list();
                for (size_t i = 0; i < l.size(); i++) hint.args.push_back(std::string(l[i].get_string()));
            }
            if (m.has_entry("params")) {
                auto p = m.at("params").get_map();
                for (auto pi = p.cbegin(); pi != p.cend(); ++pi)
                    hint.params.push_back({ std::string(pi->key), pi->value.to_json() });
            }
            if (m.has_entry("note")) hint.note = std::string(m.at("note").get_string());
            h.modules[std::string(it->key)] = hint;
        }
    }
    return h;
}

/* --------------------------------------------------- instance planning */

/*
 * A plan is the set of CCI presets that builds the dut and its dependencies
 * inside the container "platform". It is written as "name=json" lines and
 * read back by the child.
 */
// --dylib-dir: load every module library by its full path in this directory
// (for libraries outside QBox's build, such as wizard models). Empty: by name.
static std::string g_dylib_dir;

struct Plan {
    std::vector<std::pair<std::string, std::string>> presets; // name -> JSON value
    std::string arch;
    std::vector<std::string> notes;
    std::string error; // non-empty when the dut cannot be planned
};

std::string guess_arch(const std::string& type, const std::string& source)
{
    std::string s = type + " " + source;
    std::transform(s.begin(), s.end(), s.begin(), ::tolower);
    if (s.find("hexagon") != std::string::npos) return "HEXAGON";
    if (s.find("riscv32") != std::string::npos) return "RISCV32";
    for (const char* k : { "riscv", "sifive", "plic", "aplic", "aclint" })
        if (s.find(k) != std::string::npos) return "RISCV64";
    return "AARCH64";
}

class Planner
{
public:
    Planner(const std::map<std::string, Registration>& regs, const std::map<std::string, TypeInfo>& types,
            const Hints& hints)
        : m_regs(regs), m_types(types), m_hints(hints)
    {
    }

    Plan plan(const std::string& type)
    {
        Plan p;
        auto it = m_regs.find(type);
        std::string source = it == m_regs.end() ? "" : it->second.source;
        p.arch = guess_arch(type, source);
        m_plan = &p;
        m_built.clear();
        if (type != "QemuInstanceManager" && type != "QemuInstance") {
            // Most modules take the QEMU instance; create it up front so a
            // dependency chain shares one instance.
            add("qemu_inst_mgr", "QemuInstanceManager", {});
            add("qemu_inst", "QemuInstance", { "\"&platform.qemu_inst_mgr\"", json_str(p.arch) });
        }
        std::string err;
        if (!instantiate("dut", type, 0, err)) p.error = err;
        return p;
    }

private:
    const std::map<std::string, Registration>& m_regs;
    const std::map<std::string, TypeInfo>& m_types;
    const Hints& m_hints;
    Plan* m_plan = nullptr;
    std::map<std::string, std::string> m_built; // type -> instance name (dependencies only)

    void add(const std::string& inst, const std::string& type, const std::vector<std::string>& args)
    {
        auto& ps = m_plan->presets;
        ps.push_back({ "platform." + inst + ".moduletype", json_str(type) });
        // The container loads <moduletype>.so unless dylib_path names another library.
        auto t = m_types.find(type);
        if (t != m_types.end() && !t->second.library.empty() && (!g_dylib_dir.empty() || t->second.library != type + ".so")) {
            std::string lib = t->second.library.substr(0, t->second.library.size() - 3);
            if (!g_dylib_dir.empty()) lib = g_dylib_dir + "/" + lib;
            ps.push_back({ "platform." + inst + ".dylib_path", json_str(lib) });
        }
        for (size_t i = 0; i < args.size(); i++)
            ps.push_back({ "platform." + inst + ".args." + std::to_string(i), args[i] });
    }

    std::string default_cpu() const
    {
        if (m_plan->arch == "RISCV64") return "cpu_riscv64";
        if (m_plan->arch == "RISCV32") return "cpu_riscv32";
        if (m_plan->arch == "HEXAGON") return "qemu_cpu_hexagon";
        return "cpu_arm_cortexA53";
    }

    /* Return the instance to pass for an object argument cast to cls. */
    bool dependency(const std::string& cls, int depth, std::string& inst, std::string& err)
    {
        if (cls == "QemuInstance") {
            inst = "qemu_inst";
            return true;
        }
        if (cls == "QemuInstanceManager") {
            inst = "qemu_inst_mgr";
            return true;
        }
        std::string type = cls;
        auto alias = m_hints.aliases.find(cls);
        if (alias != m_hints.aliases.end()) {
            type = alias->second;
        } else if (cls == "QemuDevice" || cls == "QemuCpu") {
            type = default_cpu();
            m_plan->notes.push_back("argument of class " + cls + " filled with a " + type);
        }
        if (!m_types.count(type)) {
            err = "constructor needs a " + cls + ", which is not a registered module type";
            return false;
        }
        auto b = m_built.find(type);
        if (b != m_built.end()) {
            inst = b->second;
            return true;
        }
        inst = "dep_" + type;
        if (!instantiate(inst, type, depth + 1, err)) return false;
        m_built[type] = inst;
        return true;
    }

    bool instantiate(const std::string& inst, const std::string& type, int depth, std::string& err)
    {
        if (depth > 4) {
            err = "dependency chain too deep";
            return false;
        }
        std::vector<std::string> args;
        if (type == "QemuInstance") {
            add("qemu_inst_mgr", "QemuInstanceManager", {});
            add(inst, type, { "\"&platform.qemu_inst_mgr\"", json_str(m_plan->arch) });
            return true;
        }
        const Hint* hint = nullptr;
        auto hi = m_hints.modules.find(type);
        if (hi != m_hints.modules.end()) hint = &hi->second;
        auto it = m_regs.find(type);
        if (it != m_regs.end()) {
            size_t k = 0;
            for (auto& a : it->second.args) {
                if (a.kind == "object") {
                    std::string cls = a.cls;
                    if (hint && k < hint->args.size()) cls = hint->args[k];
                    k++;
                    if (cls.empty()) {
                        err = "cannot tell what object argument '" + a.decl + "' of " + type + " expects";
                        return false;
                    }
                    std::string dep;
                    if (!dependency(cls, depth, dep, err)) return false;
                    args.push_back(json_str("&platform." + dep));
                } else if (a.kind == "integer") {
                    args.push_back("0");
                } else if (a.kind == "bool") {
                    args.push_back("false");
                } else if (a.kind == "string") {
                    args.push_back("\"\"");
                    m_plan->notes.push_back("string argument of " + type + " left empty");
                } else {
                    err = "unsupported constructor argument type '" + a.decl + "' of " + type;
                    return false;
                }
            }
        } else if (type != "QemuInstanceManager") {
            m_plan->notes.push_back("no registration found in sources; constructed without arguments");
        }
        add(inst, type, args);
        if (hint)
            for (auto& [n, v] : hint->params) m_plan->presets.push_back({ "platform." + inst + "." + n, v });
        return true;
    }
};

/* -------------------------------------------------- introspection (child) */

class CatalogPlatform : public gs::ModuleFactory::Container
{
public:
    explicit CatalogPlatform(const sc_core::sc_module_name& n): gs::ModuleFactory::Container(n) {}
};

std::string port_kind(sc_core::sc_object* o, const std::string& t, unsigned& width);

struct PortRec {
    std::string name, kind, cpp_type;
    unsigned bus_width = 0;
    bool vector = false; // sc_vector: elements are named <name>_<i> (nested: <name>_<i>_<j>)
    size_t size = 0;     // element count with default parameters
};

/* Element kind of an sc_vector, from its first element or from the type name. */
std::string vector_kind(sc_core::sc_vector_base* v, const std::string& t, unsigned& width)
{
    auto elems = v->get_elements();
    if (!elems.empty()) {
        sc_core::sc_object* e = elems.front();
        if (auto* inner = dynamic_cast<sc_core::sc_vector_base*>(e))
            return vector_kind(inner, demangle(typeid(*e).name()), width);
        std::string k = port_kind(e, demangle(typeid(*e).name()), width);
        if (!k.empty()) return k;
    }
    unsigned w = 0;
    std::string k = port_kind(v, t, w);
    if (!k.empty()) return k;
    // Empty vector: classify from the element type name.
    if (t.find("initiator_socket") != std::string::npos || t.find("InitiatorSocket") != std::string::npos)
        return "tlm_initiator";
    if (t.find("target_socket") != std::string::npos || t.find("TargetSocket") != std::string::npos)
        return "tlm_target";
    return "";
}

std::string port_kind(sc_core::sc_object* o, const std::string& t, unsigned& width)
{
    if (t.find("InitiatorSignalSocket") != std::string::npos) return "signal_out";
    if (t.find("TargetSignalSocket") != std::string::npos) return "signal_in";
    if (t.find("biflow_socket") != std::string::npos) return "biflow";
    // Plain SystemC signal ports (sc_out / sc_in style), bound like signal sockets.
    if (t.find("sc_signal_inout_if") != std::string::npos || t.find("sc_signal_write_if") != std::string::npos)
        return "signal_out";
    if (t.find("sc_signal_in_if") != std::string::npos) return "signal_in";
    if (auto* s = dynamic_cast<tlm::tlm_base_socket_if*>(o)) {
        width = s->get_bus_width();
        switch (s->get_socket_category()) {
        case tlm::TLM_INITIATOR_SOCKET:
        case tlm::TLM_MULTI_INITIATOR_SOCKET:
            return "tlm_initiator";
        case tlm::TLM_TARGET_SOCKET:
        case tlm::TLM_MULTI_TARGET_SOCKET:
            return "tlm_target";
        default:
            return "tlm_socket";
        }
    }
    std::string k = o->kind();
    if (k == "sc_port") return "sc_port";
    if (k == "sc_export") return "sc_export";
    return "";
}

void collect_ports(sc_core::sc_object* o, size_t prefix, std::vector<PortRec>& out, std::vector<std::string>& children)
{
    for (auto* c : o->get_child_objects()) {
        std::string full = c->name();
        std::string rel = full.size() > prefix ? full.substr(prefix) : full;
        std::string t = demangle(typeid(*c).name());
        unsigned w = 0;
        if (auto* v = dynamic_cast<sc_core::sc_vector_base*>(c)) {
            std::string k = vector_kind(v, t, w);
            if (!k.empty()) {
                PortRec p{ rel, k, t, w };
                p.vector = true;
                p.size = v->size();
                out.push_back(p);
                continue;
            }
        }
        std::string k = port_kind(c, t, w);
        if (!k.empty()) {
            out.push_back({ rel, k, t, w });
            continue; // do not list a socket's internal ports
        }
        if (dynamic_cast<sc_core::sc_module*>(c)) children.push_back(rel + " (" + t + ")");
        collect_ports(c, prefix, out, children);
    }
}

int introspect(const std::string& type, const std::string& plan_file, const std::string& out_file)
{
    gs::ConfigurableBroker broker{};
    cci::cci_originator orig("qbox_catalog");
    auto bh = broker.create_broker_handle(orig);

    for (auto& line : split(read_file(plan_file), '\n')) {
        size_t eq = line.find('=');
        if (eq == std::string::npos) continue;
        bh.set_preset_cci_value(line.substr(0, eq), cci::cci_value::from_json(line.substr(eq + 1)));
    }

    CatalogPlatform platform("platform");

    sc_core::sc_object* dut = sc_core::sc_find_object("platform.dut");
    std::ofstream o(out_file);
    if (!dut) {
        o << "{\"error\":" << json_str("module was not constructed") << "}\n";
        o.close();
        _exit(0);
    }

    std::vector<PortRec> ports;
    std::vector<std::string> children;
    const std::string prefix = std::string(dut->name()) + ".";
    collect_ports(dut, prefix.size(), ports, children);

    // A TLM socket's own sc_port/sc_export shows up as a sibling named
    // <socket>_port_<n> or <socket>_export_<n>; it is not a separate port.
    std::set<std::string> socket_names;
    for (auto& p : ports)
        if (p.kind != "sc_port" && p.kind != "sc_export") socket_names.insert(p.name);
    static const std::regex internal(R"(^(.*)_(port|export)_\d+$)");
    ports.erase(std::remove_if(ports.begin(), ports.end(),
                               [&](const PortRec& p) {
                                   std::smatch m;
                                   return (p.kind == "sc_port" || p.kind == "sc_export") &&
                                          std::regex_match(p.name, m, internal) && socket_names.count(m[1]);
                               }),
                ports.end());

    o << "{\"cppType\":" << json_str(demangle(typeid(*dut).name())) << ",\n \"ports\":[";
    bool first = true;
    for (auto& p : ports) {
        o << (first ? "\n  " : ",\n  ") << "{\"name\":" << json_str(p.name) << ",\"kind\":" << json_str(p.kind);
        if (p.bus_width) o << ",\"busWidth\":" << p.bus_width;
        if (p.vector) o << ",\"vector\":true,\"defaultSize\":" << p.size;
        o << ",\"cppType\":" << json_str(p.cpp_type) << "}";
        first = false;
    }
    o << "],\n \"params\":[";
    first = true;
    auto handles = broker.create_broker_handle(orig).get_param_handles();
    std::sort(handles.begin(), handles.end(),
              [](const cci::cci_param_untyped_handle& a, const cci::cci_param_untyped_handle& b) {
                  return std::string(a.name()) < std::string(b.name());
              });
    for (auto& h : handles) {
        std::string n = h.name();
        if (n.rfind(prefix, 0) != 0) continue;
        o << (first ? "\n  " : ",\n  ") << "{\"name\":" << json_str(n.substr(prefix.size()))
          << ",\"type\":" << json_str(demangle(h.get_type_info().name()))
          << ",\"default\":" << h.get_default_cci_value().to_json()
          << ",\"description\":" << json_str(h.get_description()) << "}";
        first = false;
    }
    o << "],\n \"subModules\":[";
    first = true;
    for (auto& c : children) {
        o << (first ? "" : ",") << json_str(c);
        first = false;
    }
    o << "]}\n";
    o.close();
    // Skip elaboration and every destructor: nothing was meant to run.
    _exit(0);
}

/* ------------------------------------------------------------- driver */

struct Job {
    std::string type;
    pid_t pid = 0;
    std::string plan_file, out_file, log_file;
    std::chrono::steady_clock::time_point start;
    std::string result; // JSON object body for "introspection"
};

bool is_ok(const std::string& result) { return result.rfind("{\"status\":\"ok\"", 0) == 0; }

std::string tail(const std::string& s, size_t lines)
{
    std::vector<std::string> ls = split(s, '\n');
    while (!ls.empty() && trim(ls.back()).empty()) ls.pop_back();
    std::string o;
    for (size_t i = ls.size() > lines ? ls.size() - lines : 0; i < ls.size(); i++) o += ls[i] + "\n";
    return o;
}

/* The absolute form of a path, or the path itself when it cannot be resolved. */
std::string real_path(const std::string& p)
{
    char* r = realpath(p.c_str(), nullptr);
    if (!r) return p;
    std::string s(r);
    free(r);
    return s;
}

/*
 * The catalog text without the folders of the machine it was made on. A
 * catalog is committed and shipped with VP Studio, and those folders show up
 * in it: in qbox.libdir, in the logs of types that could not be introspected
 * ("In file: /home/me/qbox/...") and in parameter defaults a module derives
 * from where the program is. They are replaced by names:
 *   <qbox>          the QBox sources (--qbox-src)
 *   <libdir>        --libdir, when it is not inside the QBox sources
 *   <qbox-catalog>  the folder of this program
 *   ~               the home folder
 * The text is JSON, so the paths are looked for as json_str writes them.
 */
std::string without_local_paths(std::string text, const std::string& src, const std::string& libdir)
{
    std::vector<std::pair<std::string, std::string>> names;
    auto add = [&names](const std::string& path, const std::string& name) {
        if (path.size() < 2) return; /* nothing, or "/" */
        std::string quoted = json_str(path);
        names.push_back({ quoted.substr(1, quoted.size() - 2), name });
    };
    std::string qbox = real_path(src);
    std::string libs = real_path(libdir);
    add(qbox, "<qbox>");
    if (libs.compare(0, qbox.size() + 1, qbox + "/") != 0 && libs != qbox) add(libs, "<libdir>");
    std::string exe = real_path("/proc/self/exe");
    size_t slash = exe.rfind('/');
    if (slash != std::string::npos && slash > 0) add(exe.substr(0, slash), "<qbox-catalog>");
    if (const char* home = getenv("HOME")) add(real_path(home), "~");
    /* The longest first: the home folder usually holds the others. */
    std::sort(names.begin(), names.end(),
              [](const std::pair<std::string, std::string>& a, const std::pair<std::string, std::string>& b) {
                  return a.first.size() > b.first.size();
              });
    for (const auto& n : names) {
        const std::string& path = n.first;
        const std::string& name = n.second;
        size_t at = 0;
        while ((at = text.find(path, at)) != std::string::npos) {
            /* Only the folder itself or something in it, not /home/me/qbox2 for /home/me/qbox. */
            size_t end = at + path.size();
            bool whole = end >= text.size() || text[end] == '/' || text[end] == '"' || text[end] == '\\' ||
                         text[end] == ':' || text[end] == ' ' || text[end] == ')' || text[end] == '\'';
            if (!whole) {
                at = end;
                continue;
            }
            text.replace(at, path.size(), name);
            at += name.size();
        }
    }
    return text;
}

int drive(const std::string& self, const std::string& src, const std::string& libdir, const std::string& out,
          const std::string& hints_file, int jobs, const std::set<std::string>& only)
{
    Hints hints = load_hints(hints_file);
    gs::ConfigurableBroker broker{};
    cci::cci_originator orig("qbox_catalog");
    auto bh = broker.create_broker_handle(orig);

    fprintf(stderr, "scanning sources in %s\n", src.c_str());
    auto regs = scan_sources(src);
    fprintf(stderr, "loading module libraries from %s\n", libdir.c_str());
    std::vector<std::pair<std::string, std::string>> lib_errors;
    LibraryLoader loader("catalog_loader", libdir, bh, lib_errors);
    auto types = loader.types;
    fprintf(stderr, "%zu module types registered, %zu registrations found in sources\n", types.size(), regs.size());

    char tmpl[] = "/tmp/qbox-catalog-XXXXXX";
    std::string tmp = mkdtemp(tmpl) ? tmpl : "/tmp";

    Planner planner(regs, types, hints);
    std::vector<Job> queue;
    std::map<std::string, Plan> plans;
    for (auto& [name, t] : types) {
        if (!only.empty() && !only.count(name)) continue;
        plans[name] = planner.plan(name);
        Job j;
        j.type = name;
        queue.push_back(j);
    }

    std::vector<Job*> running;
    size_t next = 0, done = 0;
    while (done < queue.size()) {
        while (running.size() < static_cast<size_t>(jobs) && next < queue.size()) {
            Job& j = queue[next++];
            Plan& p = plans[j.type];
            if (!p.error.empty()) {
                j.result = "{\"status\":\"skipped\",\"reason\":" + json_str(p.error) + "}";
                done++;
                continue;
            }
            j.plan_file = tmp + "/" + j.type + ".plan";
            j.out_file = tmp + "/" + j.type + ".json";
            j.log_file = tmp + "/" + j.type + ".log";
            {
                std::ofstream pf(j.plan_file);
                for (auto& [k, v] : p.presets) pf << k << "=" << v << "\n";
            }
            j.start = std::chrono::steady_clock::now();
            j.pid = fork();
            if (j.pid == 0) {
                FILE* lf = fopen(j.log_file.c_str(), "w");
                if (lf) {
                    dup2(fileno(lf), 1);
                    dup2(fileno(lf), 2);
                }
                int devnull = open("/dev/null", 0);
                if (devnull >= 0) dup2(devnull, 0);
                execl(self.c_str(), self.c_str(), "--introspect", j.type.c_str(), "--plan", j.plan_file.c_str(),
                      "--out", j.out_file.c_str(), (char*)nullptr);
                _exit(127);
            }
            running.push_back(&j);
        }
        for (auto it = running.begin(); it != running.end();) {
            Job& j = **it;
            int st = 0;
            pid_t r = waitpid(j.pid, &st, WNOHANG);
            bool timeout = std::chrono::steady_clock::now() - j.start > std::chrono::seconds(60);
            if (r == 0 && !timeout) {
                ++it;
                continue;
            }
            if (r == 0) {
                kill(j.pid, SIGKILL);
                waitpid(j.pid, &st, 0);
            }
            std::string body = read_file(j.out_file);
            if (r != 0 && WIFEXITED(st) && WEXITSTATUS(st) == 0 && !trim(body).empty() &&
                body.find("\"error\"") != 1) {
                j.result = "{\"status\":\"ok\"," + trim(body).substr(1);
            } else {
                std::string why = timeout && r == 0 ? "timed out"
                                  : WIFSIGNALED(st)  ? std::string("killed by signal ") + strsignal(WTERMSIG(st))
                                                     : "exit status " + std::to_string(WEXITSTATUS(st));
                j.result = "{\"status\":\"failed\",\"reason\":" + json_str(why) +
                           ",\"log\":" + json_str(tail(read_file(j.log_file), 8)) + "}";
            }
            fprintf(stderr, "  %-40s %s\n", j.type.c_str(),
                    is_ok(j.result) ? "ok" : "FAILED");
            done++;
            it = running.erase(it);
        }
        if (!running.empty()) std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }

    std::string commit = run_capture("git -C '" + src + "' rev-parse HEAD 2>/dev/null");
    std::string dirty = run_capture("git -C '" + src + "' status --porcelain --untracked-files=no 2>/dev/null");
    std::time_t now = std::time(nullptr);
    char date[32];
    std::strftime(date, sizeof date, "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&now));

    std::ostringstream o;
    o << "{\n\"catalogVersion\":" << json_str(TOOL_VERSION) << ",\n\"generated\":" << json_str(date)
      << ",\n\"qbox\":{\"commit\":" << json_str(commit) << ",\"dirty\":" << (dirty.empty() ? "false" : "true")
      << ",\"libdir\":" << json_str(libdir) << "},\n\"libraryErrors\":[";
    bool first = true;
    for (auto& [lib, e] : lib_errors) {
        o << (first ? "" : ",") << "\n {\"library\":" << json_str(lib) << ",\"error\":" << json_str(e) << "}";
        first = false;
    }
    o << "],\n\"modules\":{";
    first = true;
    for (auto& j : queue) {
        const TypeInfo& t = types[j.type];
        const Plan& p = plans[j.type];
        o << (first ? "\n" : ",\n") << json_str(j.type) << ":{\"library\":" << json_str(t.library)
          << ",\"isContainer\":" << (t.is_container ? "true" : "false");
        auto r = regs.find(j.type);
        if (r != regs.end()) {
            o << ",\"source\":" << json_str(r->second.source) << ",\"args\":[";
            for (size_t i = 0; i < r->second.args.size(); i++) {
                auto& a = r->second.args[i];
                o << (i ? "," : "") << "{\"decl\":" << json_str(a.decl) << ",\"kind\":" << json_str(a.kind);
                if (!a.cls.empty()) o << ",\"expects\":" << json_str(a.cls);
                o << "}";
            }
            o << "]";
        }
        o << ",\"introspection\":" << j.result;
        auto h = hints.modules.find(j.type);
        if (h != hints.modules.end() && !h->second.params.empty()) {
            // Parameters the constructor rejected the module without; the
            // values are only what the catalog used, not recommendations.
            o << ",\"requiredParams\":[";
            for (size_t i = 0; i < h->second.params.size(); i++)
                o << (i ? "," : "") << json_str(h->second.params[i].first);
            o << "]";
        }
        if (h != hints.modules.end() && !h->second.note.empty()) o << ",\"hint\":" << json_str(h->second.note);
        if (!p.notes.empty()) {
            o << ",\"notes\":[";
            for (size_t i = 0; i < p.notes.size(); i++) o << (i ? "," : "") << json_str(p.notes[i]);
            o << "]";
        }
        o << "}";
        first = false;
    }
    o << "\n}\n}\n";
    std::ofstream catalog_file(out);
    catalog_file << without_local_paths(o.str(), src, libdir);
    catalog_file.close();

    size_t ok = 0;
    for (auto& j : queue) ok += is_ok(j.result);
    fprintf(stderr, "wrote %s: %zu modules, %zu introspected\n", out.c_str(), queue.size(), ok);
    run_capture("rm -rf '" + tmp + "'");
    return 0;
}

void usage()
{
    fprintf(stderr,
            "usage: qbox-catalog --qbox-src DIR --libdir DIR --out FILE [--hints FILE] [--jobs N] [--dylib-dir DIR]\n"
            "                    [--only TYPE,TYPE]\n"
            "       qbox-catalog --introspect TYPE --plan FILE --out FILE\n");
}

} // namespace

int sc_main(int argc, char* argv[])
{
    std::map<std::string, std::string> opt;
    for (int i = 1; i + 1 < argc; i += 2) opt[argv[i]] = argv[i + 1];

    if (opt.count("--introspect")) {
        if (!opt.count("--plan") || !opt.count("--out")) {
            usage();
            return 2;
        }
        return introspect(opt["--introspect"], opt["--plan"], opt["--out"]);
    }
    if (!opt.count("--qbox-src") || !opt.count("--libdir") || !opt.count("--out")) {
        usage();
        return 2;
    }
    if (opt.count("--dylib-dir")) g_dylib_dir = opt["--dylib-dir"];
    std::set<std::string> only;
    if (opt.count("--only"))
        for (auto& t : split(opt["--only"], ',')) only.insert(trim(t));
    int jobs = opt.count("--jobs") ? std::max(1, atoi(opt["--jobs"].c_str()))
                                   : std::max(1u, std::thread::hardware_concurrency());
    char self[4096];
    ssize_t n = readlink("/proc/self/exe", self, sizeof self - 1);
    if (n <= 0) return 1;
    self[n] = 0;
    std::string hints = opt.count("--hints") ? opt["--hints"] : "";
    if (hints.empty()) {
        // Default: hints.json next to the source, where build.sh puts the binary.
        std::string dir = self;
        dir = dir.substr(0, dir.rfind('/'));
        hints = dir + "/hints.json";
    }
    return drive(self, opt["--qbox-src"], opt["--libdir"], opt["--out"], hints, jobs, only);
}
