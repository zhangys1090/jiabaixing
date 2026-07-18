# 家百星 Kubernetes 生产部署

## 前置条件

1. 已配置 `kubectl` 并可访问目标集群
2. 集群已安装 ingress-nginx 控制器
3. 集群已安装 metrics-server（HPA 依赖）
4. 已构建并推送镜像（`jiabaixing/python-backend`、`jiabaixing/gateway`）
5. 已替换 `secret.yaml` 中的 `placeholder` 为真实密钥值

## 部署顺序

按依赖关系依次执行（也可一次性 `kubectl apply -f deploy/kubernetes/`）：

```bash
# 1. 命名空间（必须最先创建）
kubectl apply -f deploy/kubernetes/namespace.yaml

# 2. 配置与密钥
kubectl apply -f deploy/kubernetes/configmap.yaml
kubectl apply -f deploy/kubernetes/secret.yaml

# 3. 基础设施层
kubectl apply -f deploy/kubernetes/redis-deployment.yaml
kubectl apply -f deploy/kubernetes/redis-service.yaml
kubectl apply -f deploy/kubernetes/otel-collector.yaml

# 4. 应用层
kubectl apply -f deploy/kubernetes/python-deployment.yaml
kubectl apply -f deploy/kubernetes/python-service.yaml
kubectl apply -f deploy/kubernetes/gateway-deployment.yaml
kubectl apply -f deploy/kubernetes/gateway-service.yaml

# 5. 入口与弹性
kubectl apply -f deploy/kubernetes/ingress.yaml
kubectl apply -f deploy/kubernetes/hpa.yaml
kubectl apply -f deploy/kubernetes/pdb.yaml
```

## 一键部署

```bash
kubectl apply -f deploy/kubernetes/
```

## 验证

```bash
# 查看 Pod 状态（全部应为 Running）
kubectl get pods -n jiabaixing

# 查看服务
kubectl get svc -n jiabaixing

# 查看 Ingress
kubectl get ingress -n jiabaixing

# 查看 HPA 状态
kubectl get hpa -n jiabaixing

# 查看 PVC（Redis 持久化卷）
kubectl get pvc -n jiabaixing

# 查看日志
kubectl logs -n jiabaixing -l app.kubernetes.io/name=python-backend --tail=100
kubectl logs -n jiabaixing -l app.kubernetes.io/name=gateway --tail=100
```

## 卸载

```bash
bash deploy/kubernetes/uninstall.sh
```

## 水平扩展

### K8s HPA 自动扩缩

Python后端和Gateway均已配置HPA，根据CPU/Memory自动扩缩：

| 组件           | minReplicas | maxReplicas | 扩缩策略                           |
| -------------- | ----------- | ----------- | ---------------------------------- |
| Python Backend | 2           | 10          | CPU>70% / Memory>80% → 每60s扩2Pod |
| Gateway        | 2           | 6           | CPU>70% / Memory>80% → 每60s扩2Pod |

手动扩缩：

```bash
# 手动扩容 Python 后端到 5 副本
kubectl scale deployment jiabaixing-python -n jiabaixing --replicas=5

# 查看扩缩状态
kubectl get hpa -n jiabaixing
```

### Docker Compose 本地多实例

```bash
# 启动 3 个 Python 后端实例（Gateway 自动负载均衡）
docker compose up --scale python-backend=3

# 查看实例
docker compose ps
```

### 分布式锁保障

多实例部署时，分布式锁确保：

- 同一Task不会被多个实例同时执行
- 并发限流器跨实例生效（Redis ZSET信号量）
- 自动续期看门狗防止实例崩溃后锁不释放（30s超时+10s续期）

### 关键环境变量

| 变量                      | 默认值 | 说明               |
| ------------------------- | ------ | ------------------ |
| `LOCK_TIMEOUT_MS`         | 30000  | 分布式锁超时(ms)   |
| `LOCK_RETRY_INTERVAL_MS`  | 200    | 锁重试间隔(ms)     |
| `LOCK_MAX_RETRIES`        | 10     | 锁最大重试次数     |
| `LOCK_AUTO_EXTEND`        | true   | 自动续期看门狗     |
| `TRAJECTORY_MAX_ENTRIES`  | 500    | 轨迹缓冲区最大条目 |
| `TRAJECTORY_MAX_STEPS`    | 20     | 每轮最大步骤数     |
| `MAX_LISTENERS_PER_EVENT` | 200    | 每事件最大监听器   |
| `MEMORY_THRESHOLD_MB`     | 512    | 内存告警阈值(MB)   |
| `MEMORY_MONITOR_INTERVAL` | 60     | 内存监控间隔(秒)   |

## 资源清单

| 文件                    | 资源类型                     | 说明                      |
| ----------------------- | ---------------------------- | ------------------------- |
| namespace.yaml          | Namespace                    | 生产命名空间              |
| configmap.yaml          | ConfigMap                    | 非敏感环境变量            |
| secret.yaml             | Secret                       | 敏感配置（占位符）        |
| redis-deployment.yaml   | StatefulSet                  | Redis 缓存（10Gi 持久化） |
| redis-service.yaml      | Service                      | Redis ClusterIP           |
| python-deployment.yaml  | Deployment                   | Python AI 后端（2 副本）  |
| python-service.yaml     | Service                      | Python ClusterIP          |
| gateway-deployment.yaml | Deployment                   | TS 网关（2 副本）         |
| gateway-service.yaml    | Service                      | Gateway ClusterIP         |
| ingress.yaml            | Ingress                      | Nginx 入口（TLS）         |
| hpa.yaml                | HorizontalPodAutoscaler      | Python/Gateway 自动扩缩   |
| pdb.yaml                | PodDisruptionBudget          | Python/Gateway 干扰预算   |
| otel-collector.yaml     | Deployment/Service/ConfigMap | OpenTelemetry 可观测性    |
