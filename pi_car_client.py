# pi_car_client.py
import RPi.GPIO as GPIO
import socket
import time
import threading

class CarController:
    def __init__(self):
        GPIO.setmode(GPIO.BCM)
        GPIO.setup(17, GPIO.OUT)
        GPIO.setup(18, GPIO.OUT)
        GPIO.setup(22, GPIO.OUT)
        GPIO.setup(23, GPIO.OUT)
        self.stop_car()
        
    def move_forward(self):
        GPIO.output(17, False)
        GPIO.output(18, True)
        GPIO.output(22, False)
        GPIO.output(23, True)
        
    def move_backward(self):
        GPIO.output(17, True)
        GPIO.output(18, False)
        GPIO.output(22, True)
        GPIO.output(23, False)
        
    def turn_right(self):
        GPIO.output(17, False)
        GPIO.output(18, True)
        GPIO.output(22, False)
        GPIO.output(23, False)
        
    def turn_left(self):
        GPIO.output(17, False)
        GPIO.output(18, False)
        GPIO.output(22, False)
        GPIO.output(23, True)
        
    def stop_car(self):
        GPIO.output(17, False)
        GPIO.output(18, False)
        GPIO.output(22, False)
        GPIO.output(23, False)
        
    def execute_command(self, command):
        if command == 'f':
            self.move_forward()
        elif command == 'b':
            self.move_backward()
        elif command == 'r':
            self.turn_right()
        elif command == 'l':
            self.turn_left()
        elif command == 's':
            self.stop_car()
            
    def cleanup(self):
        self.stop_car()
        GPIO.cleanup()

def connect_to_server(server_ip, server_port):
    car = CarController()
    
    try:
        while True:
            try:
                # 連接到伺服器
                client_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                client_socket.connect((server_ip, server_port))
                print(f"已連接到伺服器 {server_ip}:{server_port}")
                
                while True:
                    # 接收指令
                    command = client_socket.recv(1024).decode('utf-8')
                    if not command:
                        break
                        
                    print(f"收到指令: {command}")
                    
                    if command == 'q':
                        car.cleanup()
                        client_socket.close()
                        return
                        
                    # 執行指令
                    car.execute_command(command)
                    
                    # 1.5秒後停止
                    time.sleep(1.5)
                    car.stop_car()
                    
            except ConnectionRefusedError:
                print("無法連接到伺服器，5秒後重試...")
                time.sleep(5)
            except Exception as e:
                print(f"連接錯誤: {e}")
                time.sleep(5)
            finally:
                try:
                    client_socket.close()
                except:
                    pass
                    
    except KeyboardInterrupt:
        print("程式中斷")
    finally:
        car.cleanup()

if __name__ == "__main__":
    SERVER_IP = "175.159.122.149"  # 替換為您的伺服器IP
    SERVER_PORT = 8888
    connect_to_server(SERVER_IP, SERVER_PORT)