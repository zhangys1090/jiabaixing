#!/usr/bin/env bash
# 卸载家百星 K8s 资源（反向顺序）
# 用途: 按依赖反向顺序删除所有资源，最后删除命名空间
# 用法: bash deploy/kubernetes/uninstall.sh

set -euo pipefail

NAMESPACE="jiabaixing"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=========================================="
echo "  卸载家百星 K8s 资源 (namespace: ${NAMESPACE})"
echo "=========================================="

# 反向顺序删除（与部署顺序相反）
echo "[1/7] 删除 PDB..."
kubectl delete -f "${DIR}/pdb.yaml" --ignore-not-found=true

echo "[2/7] 删除 HPA..."
kubectl delete -f "${DIR}/hpa.yaml" --ignore-not-found=true

echo "[3/7] 删除 Ingress..."
kubectl delete -f "${DIR}/ingress.yaml" --ignore-not-found=true

echo "[4/7] 删除 Gateway Deployment/Service..."
kubectl delete -f "${DIR}/gateway-service.yaml" --ignore-not-found=true
kubectl delete -f "${DIR}/gateway-deployment.yaml" --ignore-not-found=true

echo "[5/7] 删除 Python Deployment/Service..."
kubectl delete -f "${DIR}/python-service.yaml" --ignore-not-found=true
kubectl delete -f "${DIR}/python-deployment.yaml" --ignore-not-found=true

echo "[6/7] 删除 OTel Collector + Redis StatefulSet/Service..."
kubectl delete -f "${DIR}/otel-collector.yaml" --ignore-not-found=true
kubectl delete -f "${DIR}/redis-service.yaml" --ignore-not-found=true
kubectl delete -f "${DIR}/redis-deployment.yaml" --ignore-not-found=true

echo "[7/7] 删除 ConfigMap/Secret + Namespace..."
kubectl delete -f "${DIR}/secret.yaml" --ignore-not-found=true
kubectl delete -f "${DIR}/configmap.yaml" --ignore-not-found=true
kubectl delete -f "${DIR}/namespace.yaml" --ignore-not-found=true

echo "=========================================="
echo "  卸载完成"
echo "=========================================="
echo "提示: PVC 可能保留，如需彻底清理请执行："
echo "  kubectl delete pvc -n ${NAMESPACE} --all"
echo "  kubectl delete namespace ${NAMESPACE} --ignore-not-found=true"
