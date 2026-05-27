---
name: 'ui-design'
description: 'Design and implement UI components using Ant Design, improve user experience, and create responsive layouts. Invoke when user needs UI improvements, new components, or design changes.'
---

# UI Design

This skill helps design and implement UI components using Ant Design.

## When to Use

- User needs new UI components
- Improving existing UI/UX
- Creating responsive layouts
- Implementing design patterns
- Fixing visual issues
- Adding animations or interactions
- Creating dashboards or forms

## Design Process

### 1. Understand Requirements

Clarify what the user needs:

- What is the purpose of the UI?
- What data needs to be displayed?
- What interactions are needed?
- Any design preferences or constraints?

### 2. Choose Right Components

Select appropriate Ant Design components:

```typescript
// Common components
import { Button, Form, Table, Modal, Drawer, Card, Space } from 'antd';

// Icons
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
```

### 3. Component Structure

Follow this structure:

```typescript
import React, { useState, useEffect } from 'react';
import { Card, Button, Table, Space, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';

interface DataType {
  key: string;
  name: string;
  // ... other fields
}

const MyComponent: React.FC = () => {
  const [data, setData] = useState<DataType[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch data
  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      // API call
      const response = await fetch('/api/data');
      const result = await response.json();
      setData(result);
    } catch (error) {
      message.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const columns: ColumnsType<DataType> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space size="middle">
          <Button type="link">Edit</Button>
          <Button type="link" danger>Delete</Button>
        </Space>
      ),
    },
  ];

  return (
    <Card title="My Component">
      <Table
        columns={columns}
        dataSource={data}
        loading={loading}
        rowKey="key"
      />
    </Card>
  );
};

export default MyComponent;
```

### 4. Common UI Patterns

#### Data Table with Actions

```typescript
<Table
  columns={columns}
  dataSource={data}
  rowKey="id"
  pagination={{
    pageSize: 10,
    showSizeChanger: true,
    showTotal: (total) => `Total ${total} items`,
  }}
  scroll={{ x: true }}
/>
```

#### Form with Validation

```typescript
const [form] = Form.useForm();

<Form form={form} layout="vertical" onFinish={handleSubmit}>
  <Form.Item
    label="Name"
    name="name"
    rules={[{ required: true, message: 'Please input name!' }]}
  >
    <Input placeholder="Enter name" />
  </Form.Item>

  <Form.Item>
    <Button type="primary" htmlType="submit">
      Submit
    </Button>
  </Form.Item>
</Form>
```

#### Modal Dialog

```typescript
const [visible, setVisible] = useState(false);

<Modal
  title="Edit Item"
  open={visible}
  onOk={handleOk}
  onCancel={() => setVisible(false)}
  width={600}
>
  {/* Modal content */}
</Modal>
```

### 5. Responsive Design

Make UI responsive:

```typescript
// Use Grid system
import { Row, Col } from 'antd';

<Row gutter={[16, 16]}>
  <Col xs={24} sm={12} md={8} lg={6}>
    {/* Content */}
  </Col>
</Row>

// Use responsive props
<Table
  scroll={{ x: 'max-content' }}
  size={window.innerWidth < 768 ? 'small' : 'middle'}
/>
```

### 6. Styling with styled-components

```typescript
import styled from 'styled-components';

const StyledCard = styled(Card)`
  .ant-card-head {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
  }

  .ant-card-body {
    padding: 24px;
  }
`;
```

### 7. Loading States

Always show loading states:

```typescript
{loading ? (
  <Spin tip="Loading...">
    <div style={{ padding: '50px', textAlign: 'center' }} />
  </Spin>
) : (
  // Content
)}
```

### 8. Error Handling

Handle errors gracefully:

```typescript
try {
  // API call
} catch (error) {
  message.error('Operation failed');
  console.error(error);
}
```

## Tools to Use

- **Read**: Read existing components
- **SearchCodebase**: Find similar components
- **Grep**: Search for component usage
- **RunCommand**: Start dev server

## Best Practices

- Use Ant Design components consistently
- Follow existing design patterns
- Make components reusable
- Handle loading and error states
- Test on different screen sizes
- Use proper TypeScript types
- Add accessibility features
