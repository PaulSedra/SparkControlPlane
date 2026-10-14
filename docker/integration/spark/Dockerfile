FROM apache/spark:4.1.2-python3@sha256:ac7efd6404ef99d6a28ea54ea74fc8ac69c420a7af83a4718b59fecad856e447

USER root

RUN python3 -m pip install --no-cache-dir --disable-pip-version-check \
        "pandas==2.3.3" \
        "pyarrow==20.0.0" \
        "grpcio==1.76.0" \
        "grpcio-status==1.76.0" \
        "googleapis-common-protos==1.72.0" \
        "zstandard==0.25.0"

ENV HOME=/tmp \
    PYTHONPATH=/opt/spark/python:/opt/spark/python/lib/py4j-0.10.9.9-src.zip \
    SPARK_LOCAL_DIRS=/tmp/spark-local

USER spark
