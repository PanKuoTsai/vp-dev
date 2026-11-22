/*
 * vp_probes: tracer (bus accesses) and signal_tracer (signal changes),
 * the probes VP Studio puts in a platform. See probes.h.
 */
#include "probes.h"

#include <cci_configuration>
#include <module_factory_registery.h>
#include <scp/report.h>
#include <tlm_utils/simple_initiator_socket.h>
#include <tlm_utils/simple_target_socket.h>
#include <tlm_sockets_buswidth.h>
#include <ports/initiator-signal-socket.h>
#include <ports/target-signal-socket.h>
#if __has_include(<tlm-extensions/qemu-mr-hint.h>)
#include <tlm-extensions/qemu-mr-hint.h>
#define PROBES_HAVE_QEMU_HINT 1
#endif

TraceStore& TraceStore::get()
{
    static TraceStore s;
    return s;
}

bool& TraceStore::agent_access()
{
    static thread_local bool on = false;
    return on;
}

InitiatorNames& InitiatorNames::get()
{
    static InitiatorNames s;
    return s;
}

/**
 * tracer: a pass-through placed between a bus and one target socket of a
 * device. The bus maps it at the device's address (its target_socket has the
 * address and size); it forwards every call to the device unchanged and
 * records each b_transport in the TraceStore. Debug transport and DMI pass
 * through without being recorded.
 */
class tracer : public sc_core::sc_module
{
    SCP_LOGGER();

public:
    tlm_utils::simple_target_socket<tracer, DEFAULT_TLM_BUSWIDTH> target_socket;
    tlm_utils::simple_initiator_socket<tracer, DEFAULT_TLM_BUSWIDTH> initiator_socket;
    cci::cci_param<std::string> p_label;
    cci::cci_param<bool> p_allow_dmi;
    cci::cci_param<bool> p_record;
    cci::cci_param<std::string> p_router;

    explicit tracer(const sc_core::sc_module_name& n)
        : sc_core::sc_module(n)
        , target_socket("target_socket")
        , initiator_socket("initiator_socket")
        , p_label("label", "", "Name shown for this trace point (module.port of the device)")
        , p_allow_dmi("allow_dmi", false,
                      "Let initiators use DMI. Accesses through DMI bypass the tracer, so only allow it for memories "
                      "whose accesses you do not need to see. While the probe records, DMI is refused anyway.")
        , p_record("record", true, "Record from the start; trace.setPoints turns it on and off while running")
        , p_router("router", "", "The router in front of this tracer, as the platform names it (to tell who issued an access); empty: the only router")
    {
        m_router = InitiatorNames::get().router_id(p_router.get_value());
        target_socket.register_b_transport(this, &tracer::b_transport);
        target_socket.register_transport_dbg(this, &tracer::transport_dbg);
        target_socket.register_get_direct_mem_ptr(this, &tracer::get_direct_mem_ptr);
        initiator_socket.register_invalidate_direct_mem_ptr(this, &tracer::invalidate_direct_mem_ptr);
        auto broker = cci::cci_get_broker();
        const std::string a = std::string(name()) + ".target_socket.address";
        if (broker.has_preset_value(a) && broker.get_preset_cci_value(a).is_number())
            m_base = broker.get_preset_cci_value(a).get_uint64();
        m_relative = true;
        const std::string r = std::string(name()) + ".target_socket.relative_addresses";
        if (broker.has_preset_value(r) && broker.get_preset_cci_value(r).is_bool())
            m_relative = broker.get_preset_cci_value(r).get_bool();
        const std::string sz = std::string(name()) + ".target_socket.size";
        if (broker.has_preset_value(sz) && broker.get_preset_cci_value(sz).is_number())
            m_size = broker.get_preset_cci_value(sz).get_uint64();
        m_allow_dmi = p_allow_dmi.get_value();
        m_point = TraceStore::get().add_point(p_label.get_value().empty() ? std::string(name()) : p_label.get_value(),
                                              m_allow_dmi ? "memory" : "bus", p_record.get_value(),
                                              [this](bool on) { recording_changed(on); });
    }

private:
    uint64_t m_base = 0;
    uint64_t m_size = 0;
    bool m_relative = true;
    bool m_allow_dmi = false;
    uint32_t m_point = 0;
    uint16_t m_router = 0;

    /** DMI only for a memory whose probe is not recording. */
    bool dmi_ok() const { return m_allow_dmi && !TraceStore::get().point_on(m_point); }

    /**
     * A memory probe that starts recording takes back the DMI pointers handed
     * out through it, so CPUs come back through b_transport. The router adds
     * the probe's address to a relative range. QEMU CPUs drop their pointers
     * asynchronously, at their next safe point.
     */
    void recording_changed(bool on)
    {
        if (!on || !m_allow_dmi) return;
        if (m_relative)
            target_socket->invalidate_direct_mem_ptr(0, m_size ? m_size - 1 : ~sc_dt::uint64(0) - m_base);
        else
            target_socket->invalidate_direct_mem_ptr(m_base, m_size ? m_base + m_size - 1 : ~sc_dt::uint64(0));
    }

    void b_transport(tlm::tlm_generic_payload& trans, sc_core::sc_time& delay)
    {
        initiator_socket->b_transport(trans, delay);
        auto& store = TraceStore::get();
        if (!dmi_ok()) {
            // Keep initiators from going around the trace: no DMI, and no
            // QEMU memory-region hint (a QEMU CPU uses it to map a QEMU
            // device straight into its address space after the first access).
            trans.set_dmi_allowed(false);
#ifdef PROBES_HAVE_QEMU_HINT
            QemuMrHintTlmExtension* hint = nullptr;
            trans.get_extension(hint);
            if (hint) trans.release_extension(hint);
#endif
        }
        if (!store.wants(m_point)) return;
        TraceRecord r{};
        r.time_s = (sc_core::sc_time_stamp() + delay).to_seconds();
        r.point = m_point;
        r.write = trans.get_command() == tlm::TLM_WRITE_COMMAND;
        r.address = trans.get_address() + (m_relative ? m_base : 0);
        r.length = trans.get_data_length();
        const unsigned char* p = trans.get_data_ptr();
        if (p) std::memcpy(r.data, p, std::min<size_t>(sizeof r.data, r.length));
        r.status = int(trans.get_response_status());
        r.router = m_router;
        gs::PathIDExtension* path = nullptr;
        trans.get_extension(path);
        if (path) {
            // Outermost first; deeper paths than 4 routers are cut at the inner end, which resolve() rejects.
            r.npath = uint8_t(std::min<size_t>(path->size(), sizeof r.path / sizeof r.path[0]));
            for (size_t i = 0; i < r.npath; i++) r.path[i] = int16_t((*path)[i]);
            if (path->size() > r.npath) r.npath = 0;
        }
        store.record(r);
    }

    unsigned int transport_dbg(tlm::tlm_generic_payload& trans) { return initiator_socket->transport_dbg(trans); }

    bool get_direct_mem_ptr(tlm::tlm_generic_payload& trans, tlm::tlm_dmi& dmi)
    {
        if (!dmi_ok()) return false;
        return initiator_socket->get_direct_mem_ptr(trans, dmi);
    }

    void invalidate_direct_mem_ptr(sc_dt::uint64 start, sc_dt::uint64 end)
    {
        target_socket->invalidate_direct_mem_ptr(start, end);
    }
};

/**
 * signal_tracer: placed in a signal connection (an interrupt line, say):
 * the source's output binds to "in", "out" binds to the destination's input.
 * Every write is passed on unchanged; each change of level is recorded in the
 * TraceStore, with the simulated time of the write, as a record with
 * signal = true. Writes may come from a vCPU thread, like bus accesses.
 */
class signal_tracer : public sc_core::sc_module
{
public:
    TargetSignalSocket<bool> in;
    InitiatorSignalSocket<bool> out;
    cci::cci_param<std::string> p_label;
    cci::cci_param<bool> p_record;

    explicit signal_tracer(const sc_core::sc_module_name& n)
        : sc_core::sc_module(n)
        , in("in")
        , out("out")
        , p_label("label", "", "Name shown for this trace point (the source of the signal)")
        , p_record("record", true, "Record from the start; trace.setPoints turns it on and off while running")
    {
        m_point = TraceStore::get().add_point(p_label.get_value().empty() ? std::string(name()) : p_label.get_value(),
                                              "signal", p_record.get_value());
        in.register_value_changed_cb([this](const bool& v) {
            // The level is followed even while not recording, so the first
            // change recorded after turning the probe on is a real change.
            const bool changed = !m_seen || v != m_level;
            m_seen = true;
            m_level = v;
            if (changed && TraceStore::get().wants(m_point)) {
                TraceRecord r{};
                r.time_s = sc_core::sc_time_stamp().to_seconds();
                r.point = m_point;
                r.write = v;
                r.length = 1;
                r.data[0] = v ? 1 : 0;
                r.status = int(tlm::TLM_OK_RESPONSE);
                r.signal = true;
                TraceStore::get().record(r);
            }
            if (out.size()) out->write(v);
        });
    }

private:
    uint32_t m_point = 0;
    bool m_seen = false;
    bool m_level = false;
};

extern "C" void module_register();
void module_register()
{
    // Each factory is registered once, even if QBox calls this again.
    auto broker = cci::cci_get_broker();
    if (!broker.get_param_handle(CCI_GS_MF_NAME "tracer").is_valid()) GSC_MODULE_REGISTER_C(tracer);
    if (!broker.get_param_handle(CCI_GS_MF_NAME "signal_tracer").is_valid()) GSC_MODULE_REGISTER_C(signal_tracer);
}
