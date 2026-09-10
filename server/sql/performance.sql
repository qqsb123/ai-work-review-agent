-- 可选性能优化：已有数据表无需重建。
-- 运行前可先执行 SHOW INDEX FROM reports; 避免重复创建同名索引。

CREATE INDEX idx_reports_user_created_at
ON reports (user_id, created_at);

CREATE INDEX idx_reports_user_style
ON reports (user_id, style);
