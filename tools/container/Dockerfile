# QBox at the commit pinned in qbox.pin.json, with the VP Studio sim agent and
# component catalog built against it. Build with tools/container/build-image.sh
# (context: the vp-studio directory).
ARG BASE=ubuntu:24.04
FROM ${BASE}
ARG DEBIAN_FRONTEND=noninteractive
ARG JOBS=
# Packages of QBox's scripts/install_dependencies.sh for Ubuntu 24.04, plus
# what a minimal image lacks for fetching and building.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates pkg-config \
        cmake g++ gcc git libasio-dev libelf-dev libepoxy-dev \
        libfdt-dev libglib2.0-dev libjpeg-turbo8-dev libpixman-1-dev libsdl2-dev \
        libslirp-dev libvirglrenderer-dev libzip-dev \
        lld llvm meson ninja-build ocl-icd-opencl-dev python3 python3-dev \
        python3-venv bison flex \
    && rm -rf /var/lib/apt/lists/*
COPY qbox.pin.json /opt/vp-studio/qbox.pin.json
COPY catalog /opt/vp-studio/catalog
COPY tools/qbox-pin /opt/vp-studio/tools/qbox-pin
COPY tools/sim-agent /opt/vp-studio/tools/sim-agent
COPY tools/qbox-catalog /opt/vp-studio/tools/qbox-catalog
RUN bash /opt/vp-studio/tools/qbox-pin/build-qbox.sh --jobs "${JOBS:-$(nproc)}" /opt/qbox \
    && find /opt/qbox/build -name '*.o' -delete
ENV PATH=/opt/qbox/build:$PATH
WORKDIR /work
CMD ["platforms-vp", "--help"]
