describe('Jiabaixing App', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  it('should load the app successfully', () => {
    cy.contains('Jiabaixing 智能助手').should('be.visible');
  });

  it('should switch between chat, devices, and tools tabs', () => {
    // 检查初始状态（聊天标签页）
    cy.contains('聊天').should('have.class', 'active');
    
    // 切换到设备标签页
    cy.contains('设备').click();
    cy.contains('设备控制').should('be.visible');
    
    // 切换到工具标签页
    cy.contains('工具').click();
    cy.contains('工具推荐').should('be.visible');
    
    // 切换回聊天标签页
    cy.contains('聊天').click();
    cy.contains('消息输入').should('be.visible');
  });

  it('should send and receive messages in chat', () => {
    // 输入消息
    cy.get('textarea').type('Hello, Jiabaixing!');
    
    // 发送消息
    cy.contains('发送').click();
    
    // 验证消息是否发送成功
    cy.contains('Hello, Jiabaixing!').should('be.visible');
    
    // 验证是否收到回复
    cy.wait(1000); // 等待回复
    cy.get('.message.assistant').should('have.length.greaterThan', 0);
  });

  it('should display device list in devices tab', () => {
    // 切换到设备标签页
    cy.contains('设备').click();
    
    // 验证设备列表是否显示
    cy.get('.device-card').should('have.length.greaterThan', 0);
    
    // 验证设备状态是否显示
    cy.get('.device-status').should('be.visible');
  });

  it('should display tool list in tools tab', () => {
    // 切换到工具标签页
    cy.contains('工具').click();
    
    // 验证工具列表是否显示
    cy.get('.tool-card').should('have.length.greaterThan', 0);
    
    // 验证工具分类标签是否显示
    cy.get('.category-tag').should('be.visible');
  });

  it('should handle mobile menu toggle', () => {
    // 模拟移动设备
    cy.viewport('iphone-x');
    
    // 点击菜单按钮
    cy.get('.menu-button').click();
    
    // 验证侧边栏是否打开
    cy.get('.sidebar').should('have.class', 'open');
    
    // 点击关闭按钮
    cy.get('.close-sidebar').click();
    
    // 验证侧边栏是否关闭
    cy.get('.sidebar').should('not.have.class', 'open');
  });
});
