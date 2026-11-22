/*
 * debug_dap: the JTAG debug port OpenOCD connects to (VP Studio G-13). See debug_dap.h.
 */
#include "debug_dap.h"

extern "C" void module_register();
void module_register()
{
    auto broker = cci::cci_get_broker();
    if (!broker.get_param_handle(CCI_GS_MF_NAME "debug_dap").is_valid()) GSC_MODULE_REGISTER_C(debug_dap);
}
