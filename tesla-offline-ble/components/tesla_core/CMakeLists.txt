# components/tesla_core —— 纯 C 协议逻辑，不依赖 ESP-IDF，可主机编译测试。
idf_component_register(
    SRCS
        "src/tlb_sha.c"
        "src/tlb_aes.c"
        "src/tlb_pb.c"
        "src/tlb_meta.c"
        "src/tlb_msg.c"
        "src/tlb_v3.c"
        "src/tlb_frame.c"
        "src/tlb_text.c"
        "src/tlb_dispatch.c"
        "src/tlb_bind.c"
        "src/tlb_store.c"
        "src/tlb_identity.c"
    INCLUDE_DIRS "include"
)
