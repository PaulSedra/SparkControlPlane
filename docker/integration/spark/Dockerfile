# syntax=docker/dockerfile:1.8
# check=skip=InvalidDefaultArgInFrom
ARG SPARK_BASE_IMAGE
ARG JAVA_RUNTIME_IMAGE
FROM ${JAVA_RUNTIME_IMAGE} AS java-runtime

FROM ${SPARK_BASE_IMAGE}

USER root

COPY --from=java-runtime /opt/java/openjdk /opt/java/openjdk

RUN python3 -m pip install --no-cache-dir --disable-pip-version-check \
    "pandas==2.3.3" \
    "pyarrow==20.0.0"

ENV JAVA_HOME=/opt/java/openjdk \
    PATH=/opt/java/openjdk/bin:${PATH} \
    HOME=/tmp \
    PYTHONPATH=/opt/spark/python:/opt/spark/python/lib/py4j-0.10.9.9-src.zip \
    SPARK_LOCAL_DIRS=/tmp/spark-local

USER spark
